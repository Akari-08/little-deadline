
from pathlib import Path

import cv2
import mediapipe as mp


class FaceDetection:
    def __init__(self, model_path=None, min_confidence=0.5):
        if model_path is None:
            model_path = (
                Path(__file__).parent
                / "models"
                / "face_detector.tflite"
            )

        model_path = Path(model_path)

        if not model_path.exists():
            raise FileNotFoundError(
                f"Face detection model not found: {model_path}"
            )

        self.mp_image = mp.Image
        self.image_format = mp.ImageFormat.SRGB
        self.vision = mp.tasks.vision

        options = self.vision.FaceDetectorOptions(
            base_options=mp.tasks.BaseOptions(
                model_asset_path=str(model_path)
            ),
            running_mode=self.vision.RunningMode.VIDEO,
            min_detection_confidence=min_confidence,
        )

        self.detector = self.vision.FaceDetector.create_from_options(
            options
        )

        self.timestamp_ms = 0

    def detect(self, frame):
        """
        Detect faces in an OpenCV BGR frame.

        Returns a list of dictionaries containing:
        - x, y: top-left corner
        - width, height: bounding-box dimensions
        - confidence: detection confidence
        """

        if self.detector is None:
            raise RuntimeError("Face detector is closed.")

        if frame is None:
            return []

        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        image = self.mp_image(
            image_format=self.image_format,
            data=rgb_frame
        )

        self.timestamp_ms += 33

        result = self.detector.detect_for_video(
            image,
            self.timestamp_ms
        )

        faces = []

        if not result.detections:
            return faces

        for detection in result.detections:
            bbox = detection.bounding_box

            faces.append({
                "x": bbox.origin_x,
                "y": bbox.origin_y,
                "width": bbox.width,
                "height": bbox.height,
                "confidence": detection.categories[0].score
            })

        return faces

    @staticmethod
    def draw_detections(frame, faces):
        """Return a copy of the frame with detected faces marked."""

        annotated = frame.copy()

        for face in faces:
            x = face["x"]
            y = face["y"]
            width = face["width"]
            height = face["height"]
            confidence = face["confidence"]

            cv2.rectangle(
                annotated,
                (x, y),
                (x + width, y + height),
                (0, 255, 0),
                2
            )

            label = f"Face: {confidence:.2f}"

            cv2.putText(
                annotated,
                label,
                (x, max(y - 10, 20)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 0),
                2
            )

        return annotated

    def close(self):
        if self.detector is not None:
            self.detector.close()
            self.detector = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


def preview():
    from camera import Camera

    try:
        with Camera() as camera, FaceDetection() as face_detector:
            print("Face detection running. Press Q to exit.")

            while True:
                frame = camera.read()

                if frame is None:
                    print("Failed to capture frame.")
                    break

                faces = face_detector.detect(frame)

                annotated = face_detector.draw_detections(
                    frame, faces
                )

                cv2.imshow("Tamagotchi Face Detection", annotated)

                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

    except (RuntimeError, FileNotFoundError) as error:
        print(f"Error: {error}")

    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    preview()
