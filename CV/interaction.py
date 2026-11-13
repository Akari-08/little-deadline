"""Computer-vision events that drive the companion's responses."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CompanionEvent:
    kind: str
    message: str


class PresenceAndEmotion:
    """Track presence and provide rate-limited emotion responses."""

    def __init__(
        self,
        missing_frames_before_leave: int = 15,
        response_cooldown_seconds: float = 8.0,
    ):
        self.missing_frames_before_leave = missing_frames_before_leave
        self.response_cooldown_seconds = response_cooldown_seconds
        self.present = False
        self._missing_frames = 0
        self._last_emotion: str | None = None
        self._last_response_at = float("-inf")

    def update(self, result: dict, now: float) -> list[CompanionEvent]:
        events: list[CompanionEvent] = []
        detected = bool(result.get("face_detected")) and bool(result.get("faces"))

        if detected:
            if not self.present:
                events.append(CompanionEvent("presence", "Welcome back!"))
            self.present = True
            self._missing_frames = 0
        elif self.present:
            self._missing_frames += 1
            if self._missing_frames >= self.missing_frames_before_leave:
                self.present = False
                self._last_emotion = None
                events.append(CompanionEvent("absence", "I will be here when you return."))

        if not detected or not self.present:
            return events

        face = result["faces"][0]
        emotion = face.get("expression")
        if emotion is None:
            return events
        emotion = emotion.lower()
        emotion = {
            "anger": "angry",
            "sadness": "sad",
        }.get(emotion, emotion)
        if emotion == self._last_emotion:
            return events
        self._last_emotion = emotion

        if now - self._last_response_at < self.response_cooldown_seconds:
            return events

        messages = {
            "angry": ("break", "You look frustrated. Take a short break."),
            "confused": ("encouragement", "You are doing fine. Let us take it one step at a time."),
            "fear": ("encouragement", "You can do this. Try a slower breath."),
            "sad": ("encouragement", "Keep going gently. Small progress still counts."),
        }
        response = messages.get(emotion)
        if response is not None:
            kind, message = response
            self._last_response_at = now
            events.append(CompanionEvent(kind, message))
        return events
