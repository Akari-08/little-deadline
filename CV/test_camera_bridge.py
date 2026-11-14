"""Hardware-free packet, cooldown, and real model smoke tests."""
import io
import json
import math
import struct
import subprocess
import sys
import unittest
from pathlib import Path

from music_bridge import MAX_FRAME_BYTES, read_packet
from hand_gestures import GestureInterpreter, Landmark
from test_slide_gestures import two_fingers


class Fragmented(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 2))


class CameraBridgeTests(unittest.TestCase):
    def test_fragmented_packets_and_clean_eof(self):
        jpeg = b"\xff\xd8test\xff\xd9"
        stream = Fragmented(struct.pack("<IQ", len(jpeg), 1234) + jpeg)
        self.assertEqual(read_packet(stream), (1234, jpeg))
        self.assertIsNone(read_packet(stream))

    def test_reject_truncation_oversize_and_invalid_jpeg(self):
        for packet in [b"x", struct.pack("<IQ", 10, 1) + b"xx",
                       struct.pack("<IQ", MAX_FRAME_BYTES + 1, 1),
                       struct.pack("<IQ", 4, 1) + b"abcd"]:
            with self.assertRaises(ValueError):
                read_packet(io.BytesIO(packet))

    def test_hand_loss_clears_pose_but_preserves_cooldown(self):
        interpreter = GestureInterpreter(stable_frames=2)
        pose = two_fingers("right")
        self.assertIsNone(interpreter.update(pose, 0))
        self.assertEqual(interpreter.update(pose, 0.2).action, "slide_next")
        interpreter.reset_tracking()
        self.assertIsNone(interpreter.update(pose, 0.4))
        self.assertIsNone(interpreter.update(pose, 0.6))
        interpreter.reset_tracking()
        self.assertIsNone(interpreter.update(pose, 1.4))
        self.assertEqual(interpreter.update(pose, 1.6).action, "slide_next")

    def test_real_decoder_and_hand_model_process_native_800_by_600(self):
        import cv2
        import numpy as np
        ok, jpeg = cv2.imencode(".jpg", np.zeros((600, 800, 3), dtype=np.uint8))
        self.assertTrue(ok)
        payload = jpeg.tobytes()
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("music_bridge.py"))],
                                input=struct.pack("<IQ", len(payload), 1000) + payload,
                                capture_output=True, timeout=45)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(result.returncode, 0, events)
        self.assertEqual(events, [{"kind": "ready"}, {"kind": "frame_processed", "timestamp": 1000, "width": 800, "height": 600}])

    def test_unmirrored_esp_circle_direction_at_five_fps(self):
        for direction in (1, -1):
            interpreter = GestureInterpreter(stable_frames=2, mirror_volume_direction=False)
            values = []
            for index in range(32):
                angle = direction * 2 * math.pi * index / 32
                x, y = 0.5 + 0.12 * math.cos(angle), 0.4 + 0.12 * math.sin(angle)
                points = [Landmark(0.5, 0.7) for _ in range(21)]
                points[5] = Landmark(0.5 + (x - 0.5) * 0.25, 0.7 + (y - 0.7) * 0.25)
                points[6] = Landmark(0.5 + (x - 0.5) * 0.5, 0.7 + (y - 0.7) * 0.5)
                points[8] = Landmark(x, y)
                event = interpreter.update(points, index / 5)
                if event and event.action == "volume_change":
                    values.append(event.value)
            self.assertTrue(values)
            self.assertEqual(math.copysign(1, sum(values)), direction)


if __name__ == "__main__":
    unittest.main()
