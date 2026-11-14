"""Hardware-free checks for single-index-finger display navigation."""
import unittest

from hand_gestures import GestureInterpreter, Landmark, classify_gesture


def two_fingers(direction: str):
    points = [Landmark(0.5, 0.85) for _ in range(21)]
    points[0] = Landmark(0.5, 0.9)
    points[5], points[6], points[8] = Landmark(0.45, 0.7), Landmark(0.45, 0.55), Landmark(0.45, 0.3)
    points[9], points[10], points[12] = Landmark(0.65, 0.7), Landmark(0.7, 0.55), Landmark(0.9, 0.3)
    return [Landmark(1 - point.x, point.y, point.z) for point in points] if direction == "left" else points


def pointing(direction: str):
    points = [Landmark(0.4, 0.75) for _ in range(21)]
    points[0] = Landmark(0.35, 0.85)
    points[5], points[6], points[8] = Landmark(0.45, 0.5), Landmark(0.62, 0.5), Landmark(0.88, 0.5)
    if direction == "up":
        points[5], points[6], points[8] = Landmark(0.45, 0.65), Landmark(0.45, 0.45), Landmark(0.45, 0.2)
    return [Landmark(1 - p.x, p.y, p.z) for p in points] if direction == "left" else points


class SlideGestureTests(unittest.TestCase):
    def test_pointing_direction_and_one_shot_events(self):
        right = pointing("right")
        left = pointing("left")
        self.assertEqual(classify_gesture(right).name, "point_right")
        self.assertEqual(classify_gesture(left).name, "point_left")
        interpreter = GestureInterpreter(stable_frames=2)
        self.assertIsNone(interpreter.update(right, 0))
        self.assertEqual(interpreter.update(right, 0.1).action, "slide_next")
        self.assertIsNone(interpreter.update(right, 0.2))
        self.assertIsNone(interpreter.update(left, 2.0))
        self.assertEqual(interpreter.update(left, 2.1).action, "slide_previous")
        self.assertIsNone(interpreter.update(left, 2.2))

    def test_direction_uses_finger_vector_and_does_not_repeat_while_held(self):
        right = [Landmark(p.x - 0.2, p.y, p.z) for p in pointing("right")]
        self.assertEqual(classify_gesture(right).name, "point_right")
        interpreter = GestureInterpreter(stable_frames=2)
        events = [interpreter.update(right, i / 5) for i in range(25)]
        self.assertEqual([e.action for e in events if e], ["slide_next"])

    def test_upright_index_and_two_fingers_do_not_navigate(self):
        self.assertEqual(classify_gesture(pointing("up")).name, "index_pointing")
        for pose in (pointing("up"), two_fingers("right"), two_fingers("left")):
            interpreter = GestureInterpreter(stable_frames=2)
            self.assertTrue(all(interpreter.update(pose, i / 5) is None for i in range(15)))

    def test_point_then_closed_fist_toggles_once(self):
        interpreter = GestureInterpreter(stable_frames=2)
        right, fist = pointing("right"), [Landmark(0.5, 0.7) for _ in range(21)]
        interpreter.update(right, 0)
        self.assertEqual(interpreter.update(right, 0.2).action, "slide_next")
        self.assertIsNone(interpreter.update(fist, 0.4))
        self.assertEqual(interpreter.update(fist, 0.6).action, "music_toggle")
        self.assertIsNone(interpreter.update(fist, 2))
        self.assertIsNone(interpreter.update(fist, 4))

    def test_fist_after_volume_pose_can_fire_when_held_past_dropout_guard(self):
        interpreter = GestureInterpreter(stable_frames=2)
        up, fist = pointing("up"), [Landmark(0.5, 0.7) for _ in range(21)]
        interpreter.update(up, 0)
        interpreter.update(up, 0.2)
        self.assertIsNone(interpreter.update(fist, 0.4))
        self.assertIsNone(interpreter.update(fist, 0.6))
        self.assertEqual(interpreter.update(fist, 2).action, "music_toggle")
        self.assertIsNone(interpreter.update(fist, 4))


if __name__ == "__main__":
    unittest.main()
