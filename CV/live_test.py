"""Interactive webcam validation for face, emotion, and hand gestures."""

from __future__ import annotations

import argparse
import threading
import time
from pathlib import Path

import cv2
import mediapipe as mp

from emotion_recognition import EmotionRecognition
from emotion_smoothing import EmotionSmoother
from face_detection import FaceDetection
from hand_gestures import GestureInterpreter, Landmark, classify_gesture
from interaction import PresenceAndEmotion

try:
    import winsound
except ImportError:  # pragma: no cover - this harness targets Windows
    winsound = None


MODEL_PATH = Path(__file__).parent / "models" / "hand_landmarker.task"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
)

class DemoMusic:
    """A local tone player for validating music gestures without an app."""

    _TRACKS = (
        (262, 330, 392, 523),
        (330, 392, 494, 659),
        (196, 247, 294, 392),
    )

    def __init__(self):
        self.playing = True
        self.track = 0
        self.volume = 50.0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1)

    def handle(self, action: str, value: float | None = None) -> None:
        if action == "music_toggle":
            self.playing = not self.playing
        elif action == "music_next":
            self.track = (self.track + 1) % len(self._TRACKS)
        elif action == "music_previous":
            self.track = (self.track - 1) % len(self._TRACKS)
        elif action == "volume_change":
            self.volume = min(100.0, max(0.0, self.volume + (value or 0.0)))
        print(
            f"music={'playing' if self.playing else 'paused'} "
            f"track={self.track + 1} demo_volume={self.volume:.0f}"
        )

    def status(self) -> str:
        state = "playing" if self.playing else "paused"
        return f"Music: {state} track={self.track + 1} volume={self.volume:.0f}"

    def _run(self) -> None:
        note_index = 0
        while not self._stop.is_set():
            if not self.playing or winsound is None:
                self._stop.wait(0.1)
                continue
            frequency = self._TRACKS[self.track][note_index]
            duration = int(70 + self.volume)
            try:
                winsound.Beep(frequency, duration)
            except (RuntimeError, ValueError):
                self._stop.wait(0.1)
            note_index = (note_index + 1) % 4


def _hand_options():
    return mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.45,
    )


def _landmarks(result) -> list[Landmark]:
    if not result.hand_landmarks:
        return []
    return [
        Landmark(point.x, point.y, point.z)
        for point in result.hand_landmarks[0]
    ]


def _draw_hand(frame, points: list[Landmark]) -> None:
    height, width = frame.shape[:2]
    for point in points:
        center = (int(point.x * width), int(point.y * height))
        cv2.circle(frame, center, 4, (255, 180, 0), -1)


def _draw_text(frame, text: str, origin: tuple[int, int], color=(255, 255, 255)):
    cv2.putText(
        frame,
        text,
        origin,
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        color,
        2,
        cv2.LINE_AA,
    )


def run(
    camera_index: int = 0,
    skip_emotion: bool = False,
    duration_seconds: float | None = None,
) -> None:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(
            f"Hand model not found: {MODEL_PATH}\n"
            f"Download it from {MODEL_URL} and save it at that path."
        )

    capture = cv2.VideoCapture(camera_index)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open camera {camera_index}.")

    interpreter = GestureInterpreter()
    smoother = EmotionSmoother()
    presence = PresenceAndEmotion()
    face_detector = FaceDetection()
    emotion_model = None if skip_emotion else EmotionRecognition()
    timestamp_ms = 0
    last_event = "none"
    music = DemoMusic()
    music.start()

    try:
        with mp.tasks.vision.HandLandmarker.create_from_options(
            _hand_options()
        ) as hand_detector:
            print("Live CV test running. Press Q to quit.")
            print("Use one hand at a time and hold each gesture for one second.")
            started_at = time.monotonic()
            failed_reads = 0

            while True:
                success, frame = capture.read()
                if not success:
                    failed_reads += 1
                    if failed_reads >= 30:
                        raise RuntimeError(
                            "The camera returned no frame for 30 consecutive reads."
                        )
                    time.sleep(0.03)
                    continue
                failed_reads = 0

                timestamp_ms += 33
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = mp.Image(
                    image_format=mp.ImageFormat.SRGB,
                    data=rgb,
                )
                hand_result = hand_detector.detect_for_video(
                    image,
                    timestamp_ms,
                )
                points = _landmarks(hand_result)
                if points:
                    _draw_hand(frame, points)
                    gesture = classify_gesture(points)
                    _draw_text(
                        frame,
                        f"Gesture: {gesture.name}",
                        (10, 30),
                        (0, 220, 255),
                    )
                    event = interpreter.update(points, time.monotonic())
                    if event is not None:
                        last_event = event.action
                        music.handle(event.action, event.value)
                        detail = (
                            f" delta={event.value:.2f}"
                            if event.value is not None
                            else ""
                        )
                        print(
                            f"gesture={gesture.name} "
                            f"event={event.action}{detail}"
                        )

                faces = face_detector.detect(frame)
                emotion_result = (
                    emotion_model.analyze(frame, faces)
                    if emotion_model is not None
                    else {"face_detected": bool(faces), "faces": []}
                )
                smoothed = smoother.update(emotion_result)
                events = presence.update(smoothed, time.monotonic())
                for event in events:
                    print(f"companion={event.kind}: {event.message}")
                if smoothed["faces"]:
                    face = smoothed["faces"][0]
                    _draw_text(
                        frame,
                        f"Face: {face['expression']} "
                        f"({face['confidence']:.2f})",
                        (10, 60),
                        (0, 255, 0),
                    )

                _draw_text(frame, f"Last event: {last_event}", (10, 90))
                _draw_text(frame, music.status(), (10, 120))
                _draw_text(
                    frame,
                    "Q: quit | fist=music | rotate=track | circle=volume",
                    (10, frame.shape[0] - 15),
                    (220, 220, 220),
                )
                cv2.imshow("TaskPet CV Live Test", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
                if (
                    duration_seconds is not None
                    and time.monotonic() - started_at >= duration_seconds
                ):
                    break
    finally:
        capture.release()
        face_detector.close()
        music.stop()
        cv2.destroyAllWindows()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument(
        "--skip-emotion",
        action="store_true",
        help="Run face detection and gestures without loading the expression model.",
    )
    parser.add_argument(
        "--seconds",
        type=float,
        default=None,
        help="Exit automatically after this many seconds.",
    )
    args = parser.parse_args()
    run(args.camera_index, args.skip_emotion, args.seconds)


if __name__ == "__main__":
    main()
