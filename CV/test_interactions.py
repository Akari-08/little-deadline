import unittest

from emotion_smoothing import EmotionSmoother
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


class GestureTests(unittest.TestCase):
    def test_classifies_fist_and_thumbs_up(self):
        self.assertEqual(classify_gesture(hand()).name, "fist")
        self.assertEqual(
            classify_gesture(
                hand(thumb=(0.7, 0.3), index=(0.5, 0.8))
            ).name,
            "thumbs_up",
        )
        self.assertEqual(
            classify_gesture(
                hand(thumb=(0.7, 0.7), index=(0.5, 0.8))
            ).name,
            "thumbs_down",
        )

    def test_fist_is_one_shot_and_music_adapter_handles_it(self):
        interpreter = GestureInterpreter(cooldown_seconds=1)
        controller = RecordingMusicController()
        event = interpreter.update(hand(), now=0)
        self.assertEqual(event.action, "music_toggle")
        controller.handle(event.action)
        self.assertIsNone(interpreter.update(hand(), now=0.1))
        self.assertEqual(controller.commands, [("toggle_playback", None)])

    def test_invalid_interpreter_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            GestureInterpreter(circle_window=2)


class InteractionTests(unittest.TestCase):
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
