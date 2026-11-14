"""Hardware-free checks for two-finger display navigation."""
import unittest

from hand_gestures import GestureInterpreter, Landmark, classify_gesture


def two_fingers(direction: str):
    points = [Landmark(0.5, 0.85) for _ in range(21)]
    points[0] = Landmark(0.5, 0.9)
    points[5], points[6], points[8] = Landmark(0.45, 0.7), Landmark(0.45, 0.55), Landmark(0.45, 0.3)
    points[9], points[10], points[12] = Landmark(0.65, 0.7), Landmark(0.7, 0.55), Landmark(0.9, 0.3)
    return [Landmark(1 - point.x, point.y, point.z) for point in points] if direction == "left" else points


class SlideGestureTests(unittest.TestCase):
    def test_two_finger_direction_and_one_shot_events(self):
        right = two_fingers("right")
        left = two_fingers("left")
        self.assertEqual(classify_gesture(right).name, "two_fingers_right")
        self.assertEqual(classify_gesture(left).name, "two_fingers_left")
        interpreter = GestureInterpreter(stable_frames=2)
        self.assertIsNone(interpreter.update(right, 0))
        self.assertEqual(interpreter.update(right, 0.1).action, "slide_next")
        self.assertIsNone(interpreter.update(right, 0.2))
        self.assertIsNone(interpreter.update(left, 2.0))
        self.assertEqual(interpreter.update(left, 2.1).action, "slide_previous")
        self.assertIsNone(interpreter.update(left, 2.2))


if __name__ == "__main__":
    unittest.main()
