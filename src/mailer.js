export function createBrevoMailer(config) {
  return {
    async sendOtp({ email, fullName, code }) {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'api-key': config.brevoApiKey },
        body: JSON.stringify({ sender: { name: config.senderName, email: config.senderEmail }, to: [{ email, name: fullName }],
          subject: 'Mã xác thực đăng nhập Chấm công',
          textContent: `Xin chào ${fullName},\n\nMã xác thực của bạn là: ${code}\nMã có hiệu lực trong 10 phút và chỉ dùng một lần. Không chia sẻ mã với bất kỳ ai.\nNếu bạn không yêu cầu mã, hãy bỏ qua email này.\n\nChấm công Nguyễn Hoài Nam` }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Email provider rejected request.'); }
      await response.body?.cancel();
    },
  };
}
