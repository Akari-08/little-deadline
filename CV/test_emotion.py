
"""Camera smoke test for face and emotion recognition."""

import time

from camera import Camera
from emotion_recognition import EmotionRecognition
from emotion_smoothing import EmotionSmoother
from face_detection import FaceDetection


def main():
    with Camera() as camera, FaceDetection() as detector:
        emotion_model = EmotionRecognition()
        smoother = EmotionSmoother()

        while True:
            frame = camera.read()
            if frame is None:
                continue

            faces = detector.detect(frame)
            result = emotion_model.analyze(frame, faces)
            print(smoother.update(result))
            time.sleep(0.5)


if __name__ == "__main__":
    main()
