const nodemailer = require('nodemailer');

// Exemplo usando SMTP do Gmail/Outlook ou serviço gratuito (Mailtrap/SendGrid)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false, // true para porta 465, false para 587
  auth: {
    user: process.env.SMTP_USER, // Seu e-mail de envio
    pass: process.env.SMTP_PASS  // Sua senha de app / API key
  }
});

async function enviarTokenEmail(emailDestino, token) {
  const mailOptions = {
    from: '"Ingresso Amigo" <' + process.env.SMTP_USER + '>',
    to: emailDestino,
    subject: '🔑 Seu Código de Acesso - Ingresso Amigo',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2>Acesso ao Painel Admin</h2>
        <p>Utilize o código abaixo para autenticar seu acesso. O código é válido por <strong>15 minutos</strong>:</p>
        <div style="background-color: #f4f4f4; padding: 15px; font-size: 28px; font-weight: bold; letter-spacing: 5px; text-align: center; border-radius: 8px; width: 200px; margin: 20px 0;">
          ${token}
        </div>
        <p style="font-size: 12px; color: #777;">Se você não solicitou este acesso, desconsidere este e-mail.</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

module.exports = { enviarTokenEmail };