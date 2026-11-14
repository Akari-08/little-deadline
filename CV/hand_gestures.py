"""Hand-landmark gesture classification and debounced interaction events."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import acos, atan2, cos, degrees, hypot, pi, sin
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Landmark:
    x: float
    y: float
    z: float = 0.0


@dataclass(frozen=True)
class Gesture:
    name: str
    confidence: float
    angle: float | None = None


_TIPS = (4, 8, 12, 16, 20)
_PIPS = (3, 6, 10, 14, 18)
_MCPS = (2, 5, 9, 13, 17)


def _joint_angle(
    first: Landmark,
    joint: Landmark,
    last: Landmark,
) -> float:
    first_vector = (first.x - joint.x, first.y - joint.y)
    last_vector = (last.x - joint.x, last.y - joint.y)
    first_length = hypot(*first_vector)
    last_length = hypot(*last_vector)
    if first_length == 0 or last_length == 0:
        return 0
    cosine = (
        (first_vector[0] * last_vector[0])
        + (first_vector[1] * last_vector[1])
    ) / (first_length * last_length)
    return degrees(acos(max(-1.0, min(1.0, cosine))))


def _is_extended(landmarks: Sequence[Landmark], finger: int) -> bool:
    if finger > 0:
        angle = _joint_angle(
            landmarks[_MCPS[finger]],
            landmarks[_PIPS[finger]],
            landmarks[_TIPS[finger]],
        )
        wrist = landmarks[0]
        tip = landmarks[_TIPS[finger]]
        pip = landmarks[_PIPS[finger]]
        tip_distance = hypot(tip.x - wrist.x, tip.y - wrist.y)
        pip_distance = hypot(pip.x - wrist.x, pip.y - wrist.y)
        return (
            angle >= (110 if finger == 1 else 145)
            and tip_distance > pip_distance * 1.05
        )

    wrist = landmarks[0]
    tip = landmarks[_TIPS[finger]]
    pip = landmarks[_PIPS[finger]]
    tip_distance = hypot(tip.x - wrist.x, tip.y - wrist.y)
    pip_distance = hypot(pip.x - wrist.x, pip.y - wrist.y)
    return tip_distance > pip_distance * 1.12


def _looks_like_index_pointing(landmarks: Sequence[Landmark]) -> bool:
    return _is_extended(landmarks, 1)


def _validate_landmarks(landmarks: Sequence[Landmark]) -> None:
    if len(landmarks) < 21:
        raise ValueError("A hand requires 21 landmarks.")


def classify_gesture(landmarks: Iterable[Landmark]) -> Gesture:
    """Classify one hand using normalized MediaPipe-style landmarks.

    The classifier deliberately returns ``unknown`` for ambiguous poses. This
    prevents a partially visible hand from triggering a music command.
    """

    points = tuple(landmarks)
    _validate_landmarks(points)
    extended = tuple(_is_extended(points, finger) for finger in range(5))
    count = sum(extended)

    if count == 0:
        return Gesture("fist", 0.95)

    if all(extended):
        palm_angle = degrees(atan2(
            points[9].x - points[0].x,
            abs(points[9].y - points[0].y),
        ))
        if palm_angle >= 44.5:
            return Gesture("rotate_right", 0.85, palm_angle)
        if palm_angle <= -44.5:
            return Gesture("rotate_left", 0.85, palm_angle)
        return Gesture("open_hand", 0.8, palm_angle)

    if extended[1] and not any(extended[2:]):
        return Gesture("index_pointing", 0.85)

    if extended[1] and extended[2] and not extended[3] and not extended[4]:
        angle = degrees(atan2(
            points[12].y - points[8].y,
            points[12].x - points[8].x,
        ))
        if abs(angle) < 35:
            return Gesture("two_fingers_right", 0.85, angle)
        if abs(abs(angle) - 180) < 35:
            return Gesture("two_fingers_left", 0.85, angle)
        return Gesture("two_fingers", 0.7, angle)

    return Gesture("unknown", 0.4)


@dataclass(frozen=True)
class GestureEvent:
    action: str
    value: float | None = None


class GestureInterpreter:
    """Turn classified poses into one-shot, cooldown-protected commands."""

    def __init__(
        self,
        cooldown_seconds: float = 1.0,
        circle_window: int = 12,
        stable_frames: int = 5,
        volume_cooldown_seconds: float = 0.0,
        volume_lock_seconds: float = 1.5,
        volume_sensitivity: float = 8.0,
        mirror_volume_direction: bool = True,
    ):
        if cooldown_seconds < 0:
            raise ValueError("cooldown_seconds must be non-negative.")
        if circle_window < 3:
            raise ValueError("circle_window must be at least 3.")
        if stable_frames < 1:
            raise ValueError("stable_frames must be at least 1.")
        if volume_cooldown_seconds < 0:
            raise ValueError("volume_cooldown_seconds must be non-negative.")
        if volume_lock_seconds < 0:
            raise ValueError("volume_lock_seconds must be non-negative.")
        if volume_sensitivity <= 0:
            raise ValueError("volume_sensitivity must be positive.")
        self.cooldown_seconds = cooldown_seconds
        self.stable_frames = stable_frames
        self.volume_cooldown_seconds = volume_cooldown_seconds
        self.volume_lock_seconds = volume_lock_seconds
        self.volume_sensitivity = volume_sensitivity
        self._volume_direction = -1 if mirror_volume_direction else 1
        self._last_event: dict[str, float] = {}
        self._last_volume_at = float("-inf")
        self._last_index_at = float("-inf")
        self._motion_path: deque[tuple[float, float, float]] = deque(
            maxlen=12
        )
        self._circle_path: deque[tuple[float, float, float]] = deque(
            maxlen=circle_window
        )
        self._relative_circle_path: deque[
            tuple[float, float, float]
        ] = deque(maxlen=circle_window)
        self._candidate_gesture: str | None = None
        self._candidate_frames = 0
        self._stable_gesture: str | None = None
        self._last_circle_angle: float | None = None
        self._last_circle_point: tuple[float, float] | None = None
        self._last_relative_circle_angle: float | None = None
        self._last_relative_circle_point: tuple[float, float] | None = None

    def reset_tracking(self) -> None:
        """Forget old poses/motion after hand loss; retain action cooldowns."""
        self._candidate_gesture = None
        self._candidate_frames = 0
        self._stable_gesture = None
        self._motion_path.clear()
        self._circle_path.clear()
        self._relative_circle_path.clear()
        self._last_circle_angle = None
        self._last_circle_point = None
        self._last_relative_circle_angle = None
        self._last_relative_circle_point = None

    def _emit(
        self,
        action: str,
        now: float,
        value: float | None = None,
        cooldown: float | None = None,
    ) -> GestureEvent | None:
        last = self._last_event.get(action)
        cooldown = self.cooldown_seconds if cooldown is None else cooldown
        if last is not None and now - last < cooldown:
            return None
        self._last_event[action] = now
        return GestureEvent(action, value)

    def update(
        self,
        landmarks: Iterable[Landmark],
        now: float,
    ) -> GestureEvent | None:
        points = tuple(landmarks)
        gesture = classify_gesture(points)
        effective_name = gesture.name
        if (
            self._stable_gesture == "index_pointing"
            and gesture.name in {"unknown", "fist"}
            and _looks_like_index_pointing(points)
        ):
            effective_name = "index_pointing"

        if effective_name == self._candidate_gesture:
            self._candidate_frames += 1
        else:
            self._candidate_gesture = effective_name
            self._candidate_frames = 1
        stable_changed = False
        if (
            self._candidate_frames >= self.stable_frames
            and effective_name != self._stable_gesture
        ):
            self._stable_gesture = effective_name
            stable_changed = True

        if effective_name in {"open_hand", "rotate_left", "rotate_right"}:
            self._motion_path.append((points[8].x, points[8].y, now))
        else:
            self._motion_path.clear()
        if effective_name == "index_pointing":
            self._last_index_at = now
            self._circle_path.append((points[8].x, points[8].y, now))
            self._relative_circle_path.append((
                points[8].x - points[0].x,
                points[8].y - points[0].y,
                now,
            ))
        else:
            self._circle_path.clear()
            self._relative_circle_path.clear()
            self._last_circle_angle = None
            self._last_circle_point = None
            self._last_relative_circle_angle = None
            self._last_relative_circle_point = None

        if (
            self._stable_gesture == "fist"
            and stable_changed
            and now - self._last_volume_at >= self.volume_lock_seconds
            and now - self._last_index_at >= self.volume_lock_seconds
        ):
            event = self._emit("music_toggle", now)
        elif self._stable_gesture == "rotate_right" and stable_changed:
            event = self._emit("music_next", now)
        elif self._stable_gesture == "rotate_left" and stable_changed:
            event = self._emit("music_previous", now)
        elif self._stable_gesture == "two_fingers_right" and stable_changed:
            event = self._emit("slide_next", now)
        elif self._stable_gesture == "two_fingers_left" and stable_changed:
            event = self._emit("slide_previous", now)
        elif self._stable_gesture == "open_hand":
            event = self._detect_wave(now)
        else:
            event = (
                self._detect_circle(
                    now,
                    self._relative_circle_path,
                    relative=True,
                )
                if self._stable_gesture == "index_pointing"
                else None
            )
            if event is None and self._stable_gesture == "index_pointing":
                event = self._detect_circle(now, self._circle_path)
        return event

    def _detect_wave(self, now: float) -> GestureEvent | None:
        if len(self._motion_path) < 4:
            return None
        x_values = [point[0] for point in self._motion_path]
        travel = max(x_values) - min(x_values)
        if travel > 0.15:
            event = self._emit("greet", now)
            if event is not None:
                self._motion_path.clear()
            return event
        return None

    def _detect_circle(
        self,
        now: float,
        path: deque[tuple[float, float, float]],
        *,
        relative: bool = False,
    ) -> GestureEvent | None:
        if len(path) < 4:
            return None
        points = list(path)
        center_x = sum(point[0] for point in points) / len(points)
        center_y = sum(point[1] for point in points) / len(points)
        current_angle = atan2(
            points[-1][1] - center_y,
            points[-1][0] - center_x,
        )
        if relative:
            last_angle = self._last_relative_circle_angle
            last_point = self._last_relative_circle_point
        else:
            last_angle = self._last_circle_angle
            last_point = self._last_circle_point
        if last_angle is None:
            if relative:
                self._last_relative_circle_angle = current_angle
                self._last_relative_circle_point = (
                    points[-1][0],
                    points[-1][1],
                )
            else:
                self._last_circle_angle = current_angle
                self._last_circle_point = (
                    points[-1][0],
                    points[-1][1],
                )
            return None

        current_point = (points[-1][0], points[-1][1])
        if relative:
            self._last_relative_circle_point = current_point
        else:
            self._last_circle_point = current_point
        if last_point is None:
            return None
        point_distance = hypot(
            current_point[0] - last_point[0],
            current_point[1] - last_point[1],
        )
        delta = current_angle - last_angle
        if delta > pi:
            delta -= 2 * pi
        elif delta < -pi:
            delta += 2 * pi
        if relative:
            self._last_relative_circle_angle = current_angle
        else:
            self._last_circle_angle = current_angle

        if point_distance < 0.01 or abs(delta) < 0.02:
            return None

        # Legacy webcam tools mirror the view. The ESP stream stays unmirrored,
        # where positive screen angles are clockwise (image Y points down).
        event = self._emit(
            "volume_change",
            now,
            self._volume_direction * delta * self.volume_sensitivity,
            cooldown=self.volume_cooldown_seconds,
        )
        if event is not None:
            self._last_volume_at = now
        return event
