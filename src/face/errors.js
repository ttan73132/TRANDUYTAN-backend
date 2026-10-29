export class FaceRecognitionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'FaceRecognitionError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}
