// 1. SOLICITAR TOKEN
app.post('/api/auth/solicitar-token', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Informe o e-mail.' });

  try {
    const emailLimpo = email.toLowerCase().trim();
    
    // Verifica se o e-mail está cadastrado na tabela de organizadores
    const orgRes = await db.query('SELECT * FROM organizadores WHERE email = $1 AND ativo = true', [emailLimpo]);
    if (orgRes.rows.length === 0) {
      return res.status(403).json({ error: 'E-mail não autorizado como organizador.' });
    }

    // Gerar token aleatório de 6 dígitos
    const token = Math.floor(100000 + Math.random() * 900000).toString();
    const expiraEm = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // Salvar token no banco
    await db.query(
      'INSERT INTO tokens_acesso (email, token, expira_em) VALUES ($1, $2, $3)',
      [emailLimpo, token, expiraEm]
    );

    console.log(`🔑 TOKEN GERADO PARA [${emailLimpo}]: ${token}`);

    // Tenta enviar o e-mail
    try {
      await enviarTokenEmail(emailLimpo, token);
      res.json({ message: 'Código de acesso enviado para o seu e-mail!' });
    } catch (emailErr) {
      console.error('Aviso: Falha no disparo do e-mail via SMTP:', emailErr.message);
      // Retorna sucesso para a tela permitindo digitar o token consultado no log/banco
      res.json({ 
        message: 'Código gerado com sucesso! (Verifique seu e-mail ou o console de administração).' 
      });
    }

  } catch (err) {
    console.error('Erro ao processar token:', err);
    res.status(500).json({ error: 'Erro ao processar solicitação de acesso.' });
  }
});