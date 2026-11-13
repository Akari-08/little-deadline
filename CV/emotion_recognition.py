
import cv2
import torch

from PIL import Image
from transformers import (
    AutoImageProcessor,
    AutoModelForImageClassification,
)


class EmotionRecognition:
    MODEL_NAME = "trpakov/vit-face-expression"
    _EMOTION_ALIASES = {
        "sadness": "sad",
        "happiness": "happy",
        "anger": "angry",
    }

    def __init__(self):
        self.device = torch.device(
            "cuda" if torch.cuda.is_available() else "cpu"
        )

        print(f"Loading expression model on {self.device}...")

        self.processor = AutoImageProcessor.from_pretrained(
            self.MODEL_NAME
        )

        self.model = AutoModelForImageClassification.from_pretrained(
            self.MODEL_NAME
        ).to(self.device)

        self.model.eval()

        print("Expression model ready.")

    def classify_face(self, frame, face):
        """Classify the visible facial expression of one detected face."""

        height, width = frame.shape[:2]

        x = face["x"]
        y = face["y"]
        w = face["width"]
        h = face["height"]

        # Keep the crop inside the image boundaries.
        x1 = max(0, x)
        y1 = max(0, y)
        x2 = min(width, x + w)
        y2 = min(height, y + h)

        face_crop = frame[y1:y2, x1:x2]

        if face_crop.size == 0:
            return None

        # OpenCV uses BGR; the model processor expects RGB.
        rgb_crop = cv2.cvtColor(
            face_crop,
            cv2.COLOR_BGR2RGB
        )

        image = Image.fromarray(rgb_crop)

        inputs = self.processor(
            images=image,
            return_tensors="pt"
        )

        inputs = {
            key: value.to(self.device)
            for key, value in inputs.items()
        }

        with torch.inference_mode():
            outputs = self.model(**inputs)
            probabilities = torch.softmax(
                outputs.logits,
                dim=-1
            )[0]

        scores: dict[str, float] = {}
        for i, probability in enumerate(probabilities):
            label = self.model.config.id2label[i].lower()
            label = self._EMOTION_ALIASES.get(label, label)
            score = round(probability.item(), 4)
            scores[label] = max(score, scores.get(label, 0.0))

        expression = max(scores, key=scores.get)

        return {
            "expression": expression,
            "confidence": scores[expression],
            "expressions": scores,
        }

    def analyze(self, frame, faces):
        """
        Analyze all detected faces in a frame.

        Returns one result per detected face.
        """

        results = []

        for index, face in enumerate(faces):
            prediction = self.classify_face(frame, face)

            if prediction is None:
                continue

            results.append({
                "face_id": index,
                "bounding_box": {
                    "x": face["x"],
                    "y": face["y"],
                    "width": face["width"],
                    "height": face["height"],
                },
                **prediction,
            })

        return {
            "face_detected": len(results) > 0,
            "faces": results,
        }
