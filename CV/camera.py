
import cv2


class Camera:
    def __init__(self, camera_index=0):
        self.camera_index = camera_index
        self.capture = None

    def open(self):
        """Open the webcam."""
        self.capture = cv2.VideoCapture(self.camera_index)

        if not self.capture.isOpened():
            self.capture = None
            raise RuntimeError(
                f"Could not open camera {self.camera_index}"
            )

        print("Camera connected.")

    def read(self):
        """Capture and return the next video frame."""
        if self.capture is None or not self.capture.isOpened():
            raise RuntimeError("Camera is not open.")

        success, frame = self.capture.read()

        if not success:
            return None

        return frame

    def release(self):
        """Release the webcam."""
        if self.capture is not None:
            self.capture.release()
            self.capture = None

        print("Camera disconnected.")

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.release()


def preview():
    """Display the live webcam feed for testing."""
    try:
        with Camera() as camera:
            print("Press Q to exit.")

            while True:
                frame = camera.read()

                if frame is None:
                    print("Failed to capture frame.")
                    break

                cv2.imshow("Tamagotchi Camera", frame)

                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

    except RuntimeError as error:
        print(f"Camera error: {error}")

    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    preview()
