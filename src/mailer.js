const { Resend } = require('resend');

// Inicializa a API do Resend com a chave cadastrada no ambiente
const resend = new Resend(process.env.RESEND_API_KEY);

async function enviarTokenEmail(emailDestino, token) {
  const data = await resend.emails.send({
    from: 'Ingresso Amigo <onboarding@resend.dev>', // Endereço padrão de testes do Resend
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
  });

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data;
}

module.exports = { enviarTokenEmail };