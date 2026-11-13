"""Hand-landmark gesture classification and debounced interaction events."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import atan2, degrees
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


def _is_extended(landmarks: Sequence[Landmark], finger: int) -> bool:
    tip = landmarks[_TIPS[finger]]
    pip = landmarks[_PIPS[finger]]
    if finger == 0:
        return abs(tip.x - landmarks[0].x) > abs(pip.x - landmarks[0].x)
    return tip.y < pip.y


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

    if extended[0] and not any(extended[1:]):
        direction = "up" if points[4].y < points[0].y - 0.08 else "down"
        return Gesture(f"thumbs_{direction}", 0.9)

    if all(extended):
        return Gesture("open_hand", 0.8)

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
    value: int | None = None


class GestureInterpreter:
    """Turn classified poses into one-shot, cooldown-protected commands."""

    def __init__(self, cooldown_seconds: float = 1.0, circle_window: int = 12):
        if cooldown_seconds < 0:
            raise ValueError("cooldown_seconds must be non-negative.")
        if circle_window < 3:
            raise ValueError("circle_window must be at least 3.")
        self.cooldown_seconds = cooldown_seconds
        self._last_event: dict[str, float] = {}
        self._motion_path: deque[tuple[float, float, float]] = deque(
            maxlen=12
        )
        self._circle_path: deque[tuple[float, float, float]] = deque(
            maxlen=circle_window
        )
        self._previous_gesture: str | None = None

    def _emit(
        self,
        action: str,
        now: float,
        value: int | None = None,
    ) -> GestureEvent | None:
        last = self._last_event.get(action)
        if last is not None and now - last < self.cooldown_seconds:
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
        if gesture.name == "open_hand":
            self._motion_path.append((points[8].x, points[8].y, now))
        else:
            self._motion_path.clear()

        if gesture.name == "fist" and self._previous_gesture != "fist":
            event = self._emit("music_toggle", now)
        elif gesture.name == "thumbs_up" and self._previous_gesture != "thumbs_up":
            event = self._emit("positive_feedback", now)
        elif gesture.name == "thumbs_down" and self._previous_gesture != "thumbs_down":
            event = self._emit("negative_feedback", now)
        elif gesture.name == "two_fingers_right":
            event = self._emit("music_next", now)
        elif gesture.name == "two_fingers_left":
            event = self._emit("music_previous", now)
        elif gesture.name == "open_hand":
            event = self._detect_wave(now)
        else:
            if gesture.name == "unknown":
                self._circle_path.append((points[8].x, points[8].y, now))
            else:
                self._circle_path.clear()
            event = self._detect_circle(now)

        self._previous_gesture = gesture.name
        return event

    def _detect_wave(self, now: float) -> GestureEvent | None:
        if len(self._motion_path) < 4:
            return None
        x_values = [point[0] for point in self._motion_path]
        travel = max(x_values) - min(x_values)
        if travel > 0.15:
            return self._emit("greet", now)
        return None

    def _detect_circle(self, now: float) -> GestureEvent | None:
        if len(self._circle_path) < self._circle_path.maxlen:
            return None
        points = list(self._circle_path)
        signed_area = sum(
            (points[index][0] * points[(index + 1) % len(points)][1])
            - (points[(index + 1) % len(points)][0] * points[index][1])
            for index in range(len(points))
        )
        if abs(signed_area) < 0.02:
            return None
        return self._emit(
            "volume_up" if signed_area > 0 else "volume_down",
            now,
        )
