
from collections import deque


class EmotionSmoother:
    def __init__(
        self,
        window_size=10,
        min_confidence=0.45,
        max_missing_frames=15,
    ):
        if window_size < 1:
            raise ValueError("window_size must be at least 1.")
        if not 0 <= min_confidence <= 1:
            raise ValueError("min_confidence must be between 0 and 1.")
        if max_missing_frames < 0:
            raise ValueError("max_missing_frames must be non-negative.")
        self.window_size = window_size
        self.min_confidence = min_confidence
        self.max_missing_frames = max_missing_frames

        self.history = {}
        self.missing_frames = {}

    def update(self, result):
        """
        Smooth expression probabilities across recent frames.

        Takes the output of EmotionRecognition.analyze()
        and returns the same structure with smoothed predictions.
        """

        output = {
            "face_detected": result["face_detected"],
            "faces": [],
        }

        current_faces = set()

        for face in result["faces"]:
            face_id = face["face_id"]
            current_faces.add(face_id)

            if face_id not in self.history:
                self.history[face_id] = deque(
                    maxlen=self.window_size
                )

            self.missing_frames[face_id] = 0

            # Store the probability scores, not just the label.
            self.history[face_id].append(
                face["expressions"]
            )

            # Calculate average probability for each expression.
            history = self.history[face_id]

            emotions = set().union(*(prediction for prediction in history))
            averaged_scores = {
                emotion: sum(
                    prediction.get(emotion, 0.0)
                    for prediction in history
                ) / len(history)
                for emotion in emotions
            }

            # Find the strongest expression.
            expression = max(
                averaged_scores,
                key=averaged_scores.get
            )

            confidence = averaged_scores[expression]

            smoothed_face = {
                **face,
                "expression": (
                    expression
                    if confidence >= self.min_confidence
                    else None
                ),
                "confidence": round(confidence, 4),
                "expressions": {
                    emotion: round(score, 4)
                    for emotion, score in averaged_scores.items()
                },
            }

            output["faces"].append(smoothed_face)

        # Track faces that disappeared.
        for face_id in list(self.history):
            if face_id not in current_faces:
                self.missing_frames[face_id] += 1

                if (
                    self.missing_frames[face_id]
                    > self.max_missing_frames
                ):
                    del self.history[face_id]
                    del self.missing_frames[face_id]

        return output

    def reset(self):
        """Clear all stored prediction histories."""

        self.history.clear()
        self.missing_frames.clear()
