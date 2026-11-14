"""Recognize gestures from ESP JPEG frames supplied by the local Node host.

stdin: little-endian uint32 JPEG length + uint64 monotonic timestamp (ms), then
JPEG bytes. stdout: bounded events and one acknowledgement per processed frame.
No network credentials, recording, or computer-webcam access.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path
from typing import BinaryIO

from hand_gestures import GestureInterpreter, Landmark

MODEL = Path(__file__).parent / "models" / "hand_landmarker.task"
MAX_FRAME_BYTES = 512 * 1024


def emit(kind: str, **fields: object) -> None:
    print(json.dumps({"kind": kind, **fields}, separators=(",", ":")), flush=True)


def read_exact(stream: BinaryIO, size: int, allow_eof: bool = False) -> bytes | None:
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(size - len(result))
        if not chunk:
            if not result and allow_eof:
                return None
            raise ValueError("Truncated camera packet")
        result.extend(chunk)
    return bytes(result)


def read_packet(stream: BinaryIO) -> tuple[int, bytes] | None:
    header = read_exact(stream, 12, allow_eof=True)
    if header is None:
        return None
    length, timestamp = struct.unpack("<IQ", header)
    if length < 4 or length > MAX_FRAME_BYTES or timestamp > 2**53 - 1:
        raise ValueError("Invalid camera packet")
    jpeg = read_exact(stream, length)
    if not jpeg or not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
        raise ValueError("Invalid JPEG packet")
    return timestamp, jpeg


def run() -> None:
    try:
        import cv2
        import mediapipe as mp
        import numpy as np
    except ImportError:
        emit("error", message="Install the CV/requirements.txt dependencies in .venv to use ESP32 gestures.")
        return
    if not MODEL.is_file():
        emit("error", message="The bundled hand-landmarker model is missing.")
        return
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.45,
    )
    # Two observations at the ESP's target 5 fps; held poses still fire once.
    interpreter = GestureInterpreter(stable_frames=2, mirror_volume_direction=False)
    previous_timestamp = -1
    with mp.tasks.vision.HandLandmarker.create_from_options(options) as detector:
        emit("ready")
        while (packet := read_packet(sys.stdin.buffer)) is not None:
            timestamp, jpeg = packet
            if timestamp <= previous_timestamp:
                raise ValueError("Camera timestamps must increase")
            if timestamp - previous_timestamp > 1000:
                interpreter.reset_tracking()
            previous_timestamp = timestamp
            frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError("Camera JPEG could not be decoded")
            height, width = frame.shape[:2]
            if width > 8192 or height > 8192:
                raise ValueError("Camera dimensions exceed limit")
            # Preserve native capture detail up to 960px; never upscale for detection.
            scale = min(1.0, 960 / max(width, height))
            if scale < 1:
                frame = cv2.resize(frame, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = detector.detect_for_video(image, timestamp)
            event = None
            if result.hand_landmarks:
                points = [Landmark(p.x, p.y, p.z) for p in result.hand_landmarks[0]]
                event = interpreter.update(points, timestamp / 1000)
            else:
                interpreter.reset_tracking()
            emit("frame_processed", timestamp=timestamp, width=width, height=height)
            if event and event.action in ("music_toggle", "music_next", "music_previous", "volume_change", "greet", "slide_next", "slide_previous"):
                emit("gesture", action=event.action, value=event.value)


if __name__ == "__main__":
    try:
        run()
    except Exception:
        emit("error", message="Gesture recognition stopped. Check the ESP32 feed and CV dependencies.")
        sys.exit(1)
