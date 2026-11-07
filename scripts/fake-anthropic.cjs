// Minimal stand-in for the Anthropic Messages API, used only by the e2e check so the
// assistant's real SDK code path (structured output, history storage) runs without a key.
// Start the app with ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=test.
const http = require('node:http');

const port = Number(process.argv[2] || 4010);
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    const prompt = JSON.stringify(p.messages || []);
    const wantsTitle = JSON.stringify(p.output_config || {}).includes('"title"');
    let out;
    if (wantsTitle) out = { title: 'Card brand volume' };
    else if (prompt.includes('Modify this query')) out = { sql: "SELECT card_brand, sum(amount) / 100.0 AS volume\nFROM charges\nWHERE status = 'succeeded'\nGROUP BY 1\nORDER BY volume ASC", explanation: 'Sorted the card brands by volume, smallest first.' };
    else out = { sql: "SELECT card_brand, sum(amount) / 100.0 AS volume\nFROM charges\nWHERE status = 'succeeded'\nGROUP BY 1\nORDER BY volume DESC", explanation: 'Successful charge volume per card brand, in dollars.' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'msg_fake', type: 'message', role: 'assistant', model: p.model, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(out) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
}).listen(port, '127.0.0.1', () => console.log(`fake Anthropic API on ${port}`));
