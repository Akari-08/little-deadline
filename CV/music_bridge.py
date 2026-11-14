"""Emit existing hand-gesture music events to the local Lil Deadline host.

Uses the computer webcam. Frames and landmarks stay in this process; stdout
contains only bounded event names and volume deltas. The Node host owns Spotify.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from hand_gestures import GestureInterpreter, Landmark

MODEL = Path(__file__).parent / "models" / "hand_landmarker.task"


def emit(kind: str, **fields: object) -> None:
    print(json.dumps({"kind": kind, **fields}, separators=(",", ":")), flush=True)


def run() -> None:
    try:
        import cv2
        import mediapipe as mp
    except ImportError:
        emit("error", message="Install opencv-python and mediapipe to use computer-webcam gestures.")
        return
    if not MODEL.is_file():
        emit("error", message="The bundled hand-landmarker model is missing.")
        return
    capture = cv2.VideoCapture(0)
    if not capture.isOpened():
        emit("error", message="Computer webcam unavailable or already in use.")
        return
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.45,
    )
    interpreter = GestureInterpreter()
    timestamp = 0
    failed = 0
    try:
        with mp.tasks.vision.HandLandmarker.create_from_options(options) as detector:
            emit("ready")
            while True:
                ok, frame = capture.read()
                if not ok:
                    failed += 1
                    if failed >= 30:
                        emit("error", message="Computer webcam stopped returning frames.")
                        return
                    time.sleep(0.03)
                    continue
                failed = 0
                timestamp += 33
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                result = detector.detect_for_video(image, timestamp)
                if not result.hand_landmarks:
                    continue
                points = [Landmark(p.x, p.y, p.z) for p in result.hand_landmarks[0]]
                event = interpreter.update(points, time.monotonic())
                if event is None:
                    continue
                if event.action in ("music_toggle", "music_next", "music_previous", "volume_change", "greet", "slide_next", "slide_previous"):
                    emit("gesture", action=event.action, value=event.value)
    finally:
        capture.release()


if __name__ == "__main__":
    try:
        run()
    except Exception:
        # Avoid printing stack traces that may contain local paths or media data.
        emit("error", message="Gesture recognition stopped. Check the computer webcam and CV dependencies.")
        sys.exit(1)
