"""Small music-control adapter for gesture events.

The adapter has no platform-specific dependency. Applications can implement
the protocol for their player, while tests and the CV preview can use the
recording implementation below.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


class MusicController(Protocol):
    def toggle_playback(self) -> None: ...
    def next_track(self) -> None: ...
    def previous_track(self) -> None: ...
    def change_volume(self, delta: int) -> None: ...


@dataclass
class RecordingMusicController:
    """A safe default that records commands without controlling the OS."""

    commands: list[tuple[str, int | None]] = field(default_factory=list)

    def toggle_playback(self) -> None:
        self.commands.append(("toggle_playback", None))

    def next_track(self) -> None:
        self.commands.append(("next_track", None))

    def previous_track(self) -> None:
        self.commands.append(("previous_track", None))

    def change_volume(self, delta: int) -> None:
        self.commands.append(("change_volume", delta))

    def handle(self, action: str) -> None:
        actions = {
            "music_toggle": self.toggle_playback,
            "music_next": self.next_track,
            "music_previous": self.previous_track,
        }
        if action in actions:
            actions[action]()
        elif action == "volume_up":
            self.change_volume(1)
        elif action == "volume_down":
            self.change_volume(-1)
