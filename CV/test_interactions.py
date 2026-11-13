import math
import unittest

from emotion_smoothing import EmotionSmoother
from emotion_recognition import EmotionRecognition
from hand_gestures import GestureInterpreter, Landmark, classify_gesture
from interaction import PresenceAndEmotion
from music_control import RecordingMusicController


def hand(
    *,
    thumb=(0.5, 0.7),
    index=(0.5, 0.8),
    middle=(0.6, 0.8),
    ring=(0.5, 0.8),
    pinky=(0.5, 0.8),
):
    points = [Landmark(0.5, 0.7) for _ in range(21)]
    points[4] = Landmark(*thumb)
    points[8] = Landmark(*index)
    points[12] = Landmark(*middle)
    points[16] = Landmark(*ring)
    points[20] = Landmark(*pinky)
    points[3] = Landmark(0.48, 0.6)
    points[6] = Landmark(0.5, 0.6)
    points[10] = Landmark(0.6, 0.6)
    points[14] = Landmark(0.5, 0.6)
    points[18] = Landmark(0.5, 0.6)
    return points


def open_hand(*, rotation: float = 0.0):
    points = [Landmark(0.5, 0.7) for _ in range(21)]
    for mcp, pip, tip in ((2, 3, 4), (5, 6, 8), (9, 10, 12), (13, 14, 16), (17, 18, 20)):
        points[mcp] = Landmark(0.5 + rotation * 0.35, 0.7 - 0.5 * 0.35)
        points[pip] = Landmark(0.5 + rotation * 0.65, 0.7 - 0.5 * 0.65)
        points[tip] = Landmark(0.5 + rotation, 0.2)
    return points


def sideways_index():
    points = hand(index=(0.8, 0.6))
    points[5] = Landmark(0.3, 0.6)
    points[6] = Landmark(0.5, 0.6)
    return points


def pointing_index(x, y):
    points = hand()
    wrist = points[0]
    points[5] = Landmark(
        wrist.x + (x - wrist.x) * 0.25,
        wrist.y + (y - wrist.y) * 0.25,
    )
    points[6] = Landmark(
        wrist.x + (x - wrist.x) * 0.5,
        wrist.y + (y - wrist.y) * 0.5,
    )
    points[8] = Landmark(x, y)
    return points


def shifted(points, x, y):
    return [
        Landmark(point.x + x, point.y + y, point.z)
        for point in points
    ]


class GestureTests(unittest.TestCase):
    def test_classifies_fist_and_index_pointing(self):
        self.assertEqual(classify_gesture(hand()).name, "fist")
        self.assertEqual(
            classify_gesture(
                hand(thumb=(0.7, 0.3), index=(0.5, 0.8))
            ).name,
            "unknown",
        )
        self.assertEqual(
            classify_gesture(sideways_index()).name,
            "index_pointing",
        )
        self.assertEqual(classify_gesture(open_hand()).name, "open_hand")
        self.assertEqual(
            classify_gesture(open_hand(rotation=0.5)).name,
            "rotate_right",
        )
        self.assertEqual(
            classify_gesture(open_hand(rotation=-0.5)).name,
            "rotate_left",
        )

    def test_fist_is_one_shot_and_music_adapter_handles_it(self):
        interpreter = GestureInterpreter(cooldown_seconds=1, stable_frames=1)
        controller = RecordingMusicController()
        event = interpreter.update(hand(), now=0)
        self.assertEqual(event.action, "music_toggle")
        controller.handle(event.action)
        self.assertIsNone(interpreter.update(hand(), now=0.1))
        self.assertEqual(controller.commands, [("toggle_playback", None)])

    def test_invalid_interpreter_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            GestureInterpreter(circle_window=2)
        with self.assertRaises(ValueError):
            GestureInterpreter(stable_frames=0)
        with self.assertRaises(ValueError):
            GestureInterpreter(volume_lock_seconds=-1)
        with self.assertRaises(ValueError):
            GestureInterpreter(volume_sensitivity=0)

    def test_jitter_does_not_repeat_fist_event(self):
        interpreter = GestureInterpreter(stable_frames=3)
        self.assertIsNone(interpreter.update(hand(), now=0))
        self.assertIsNone(interpreter.update(hand(), now=0.1))
        self.assertEqual(interpreter.update(hand(), now=0.2).action, "music_toggle")

        unknown = hand(thumb=(0.7, 0.3), index=(0.5, 0.8))
        interpreter.update(unknown, now=0.3)
        interpreter.update(hand(), now=0.4)
        interpreter.update(unknown, now=0.5)
        self.assertIsNone(interpreter.update(hand(), now=0.6))

    def test_rotation_changes_track_without_feedback_events(self):
        interpreter = GestureInterpreter(stable_frames=1)
        self.assertEqual(
            interpreter.update(open_hand(rotation=0.5), now=0).action,
            "music_next",
        )
        self.assertEqual(
            interpreter.update(open_hand(rotation=-0.5), now=2).action,
            "music_previous",
        )

    def test_rotation_below_45_degrees_does_not_change_track(self):
        interpreter = GestureInterpreter(stable_frames=1)
        self.assertIsNone(interpreter.update(open_hand(rotation=0.3), now=0))

    def test_stationary_index_does_not_change_volume(self):
        interpreter = GestureInterpreter(stable_frames=1)
        points = pointing_index(0.62, 0.5)
        self.assertIsNone(interpreter.update(points, now=0))
        for index in range(1, 20):
            self.assertIsNone(interpreter.update(points, now=index / 30))

    def test_index_dropout_does_not_pause_music(self):
        interpreter = GestureInterpreter(stable_frames=1)
        self.assertIsNone(
            interpreter.update(pointing_index(0.62, 0.5), now=0)
        )
        self.assertIsNone(interpreter.update(hand(), now=0.2))

    def test_music_commands_are_recorded(self):
        controller = RecordingMusicController()
        controller.handle("music_toggle")
        controller.handle("music_next")
        controller.handle("music_previous")
        self.assertEqual(
            controller.commands,
            [
                ("toggle_playback", None),
                ("next_track", None),
                ("previous_track", None),
            ],
        )

    def test_circle_emits_continuous_volume_deltas(self):
        interpreter = GestureInterpreter(
            stable_frames=1,
        )
        events = []
        for index in range(32):
            angle = 2 * 3.141592653589793 * index / 32
            event = interpreter.update(
                pointing_index(
                    0.5 + 0.12 * math.cos(angle),
                    0.5 + 0.12 * math.sin(angle),
                ),
                now=index / 30,
            )
            if event is not None:
                events.append(event)
        self.assertGreaterEqual(len(events), 10)
        self.assertTrue(all(event.action == "volume_change" for event in events))
        self.assertTrue(all((event.value or 0) < 0 for event in events))
        self.assertLess(max(event.value for event in events), 2)

    def test_clockwise_up_and_counterclockwise_down(self):
        for direction, expected_sign in ((1, -1), (-1, 1)):
            interpreter = GestureInterpreter(stable_frames=1)
            values = []
            for index in range(32):
                angle = direction * 2 * math.pi * index / 32
                event = interpreter.update(
                    pointing_index(
                        0.5 + 0.12 * math.cos(angle),
                        0.5 + 0.12 * math.sin(angle),
                    ),
                    now=index / 30,
                )
                if event is not None:
                    values.append(event.value or 0)
            self.assertTrue(values)
            self.assertEqual(math.copysign(1, sum(values)), expected_sign)

    def test_whole_hand_motion_can_change_volume(self):
        interpreter = GestureInterpreter(stable_frames=1)
        values = []
        base = pointing_index(0.62, 0.5)
        for index in range(32):
            angle = 2 * math.pi * index / 32
            event = interpreter.update(
                shifted(
                    base,
                    0.12 * math.cos(angle),
                    0.12 * math.sin(angle),
                ),
                now=index / 30,
            )
            if event is not None:
                values.append(event.value or 0)
        self.assertTrue(values)
        self.assertLess(sum(values), 0)


class InteractionTests(unittest.TestCase):
    def test_emotion_model_aliases_sadness(self):
        self.assertEqual(
            EmotionRecognition._EMOTION_ALIASES["sadness"],
            "sad",
        )

    def test_smoother_accepts_changed_expression_keys(self):
        smoother = EmotionSmoother(window_size=2)
        first = {
            "face_detected": True,
            "faces": [{
                "face_id": 0,
                "expressions": {"happy": 0.8},
                "expression": "happy",
                "confidence": 0.8,
            }],
        }
        second = {
            "face_detected": True,
            "faces": [{
                "face_id": 0,
                "expressions": {"sad": 0.9},
                "expression": "sad",
                "confidence": 0.9,
            }],
        }
        smoother.update(first)
        result = smoother.update(second)
        self.assertIn("happy", result["faces"][0]["expressions"])
        self.assertIn("sad", result["faces"][0]["expressions"])

    def test_presence_and_angry_response(self):
        tracker = PresenceAndEmotion(missing_frames_before_leave=2)
        result = {
            "face_detected": True,
            "faces": [{"expression": "angry"}],
        }
        events = tracker.update(result, now=10)
        self.assertEqual([event.kind for event in events], ["presence", "break"])

        self.assertEqual(tracker.update({"face_detected": False, "faces": []}, 11), [])
        events = tracker.update({"face_detected": False, "faces": []}, 12)
        self.assertEqual(events[0].kind, "absence")

    def test_presence_normalizes_model_emotion_aliases(self):
        tracker = PresenceAndEmotion()
        for index, (expression, expected_kind) in enumerate(
            (
            ("anger", "break"),
            ("sadness", "encouragement"),
            )
        ):
            events = tracker.update(
                {
                    "face_detected": True,
                    "faces": [{"expression": expression}],
                },
                now=100 + index * 10,
            )
            self.assertEqual(events[-1].kind, expected_kind)
            tracker._last_emotion = None

    def test_response_is_rate_limited(self):
        tracker = PresenceAndEmotion(response_cooldown_seconds=10)
        result = {
            "face_detected": True,
            "faces": [{"expression": "confused"}],
        }
        self.assertEqual(len(tracker.update(result, 0)), 2)
        tracker._last_emotion = None
        self.assertEqual(tracker.update(result, 1), [])


if __name__ == "__main__":
    unittest.main()
