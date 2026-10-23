const nodemailer = require('nodemailer');

// Utiliza o serviço 'gmail' nativo do Nodemailer (gerencia automaticamente conexões SSL/TLS)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  connectionTimeout: 10000, // 10s para estabelecer conexão
  greetingTimeout: 10000,
  socketTimeout: 15000
});

async function enviarTokenEmail(emailDestino, token) {
  const mailOptions = {
    from: `"Ingresso Amigo" <${process.env.SMTP_USER}>`,
    to: emailDestino,
    subject: '🔑 Seu Código de Acesso - Ingresso Amigo',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2>Acesso ao Painel Admin</h2>
        <p>Utilize o código abaixo para autenticar seu acesso no sistema. Ele é válido por <strong>15 minutos</strong>:</p>
        <div style="background-color: #f4f4f4; padding: 15px; font-size: 28px; font-weight: bold; letter-spacing: 5px; text-align: center; border-radius: 8px; width: 220px; margin: 20px 0; color: #0d6efd;">
          ${token}
        </div>
        <p style="font-size: 12px; color: #777;">Se você não solicitou este acesso, desconsidere este e-mail.</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

module.exports = { enviarTokenEmail };