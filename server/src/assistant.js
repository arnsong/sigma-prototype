// Natural-language -> Trino SQL assistant, powered by Claude.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import { prepareQuery } from './sql.js';

const Answer = z.object({
  sql: z.string().describe('A single read-only Trino SQL statement, without a trailing semicolon. Empty if the question cannot be answered from the schema.'),
  explanation: z.string().describe('One or two sentences on what the query does, or why it could not be written.'),
});

const Title = z.object({ title: z.string() });

/** Fallback title from the tables a query reads, e.g. "Charges and customers query". */
export function heuristicTitle(sql) {
  const tables = [];
  for (const m of String(sql).matchAll(/\b(?:from|join)\s+([\w."]+)/gi)) {
    const t = m[1].replace(/"/g, '').split('.').pop();
    if (t && !tables.includes(t) && !/^(unnest|select|lateral)$/i.test(t)) tables.push(t);
  }
  if (tables.length === 0) return 'Untitled query';
  const words = tables.slice(0, 3).map(t => t.replace(/_/g, ' '));
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
  return `${list[0].toUpperCase()}${list.slice(1)} query`;
}

export function assistantEnabled(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ASSISTANT_ENABLED === 'true');
}

/** Render the schema browser payload as compact text for the system prompt. */
export function schemaToText(schema, defaultCatalog, defaultSchema) {
  const lines = [];
  for (const s of schema) {
    const isDefault = s.catalog === defaultCatalog && s.schema === defaultSchema;
    lines.push(`## ${s.catalog}.${s.schema}${isDefault ? ' (default — tables can be referenced unqualified)' : ''}`);
    for (const t of s.tables) {
      lines.push(`table ${t.name}${t.description ? ` -- ${t.description}` : ''}`);
      for (const c of t.columns) lines.push(`  ${c.name} ${c.type}${c.description ? ` -- ${c.description}` : ''}`);
    }
  }
  return lines.join('\n');
}

export class Assistant {
  /**
   * @param {{getSchema: () => Promise<any[]>, catalog: string, schema: string, model?: string, client?: Anthropic}} opts
   */
  constructor({ getSchema, catalog, schema, model, client }) {
    this.getSchema = getSchema;
    this.catalog = catalog;
    this.schema = schema;
    this.model = model || 'claude-opus-5-5';
    this.client = client || new Anthropic();
  }

  /**
   * @param {{question: string, mode?: 'generate'|'edit', currentSql?: string, error?: string, history?: {prompt: string, sql: string}[]}} req
   * Generate writes a new query and ignores the editor; Edit modifies the SQL in the editor.
   */
  async ask({ question, mode = 'generate', currentSql = '', error = '', history = [] }) {
    const schemaText = schemaToText(await this.getSchema(), this.catalog, this.schema);
    // Stable content (instructions + schema) goes in the cached system prompt;
    // anything that changes per request goes in the user message.
    const system = [
      {
        type: 'text',
        text:
          'You write SQL for Trino. Answer the analyst\'s question with exactly one read-only statement ' +
          '(SELECT, WITH, SHOW, DESCRIBE or EXPLAIN) using only the tables and columns listed below.\n' +
          '- Use Trino functions and syntax (date_trunc, date_diff, count_if, approx_percentile, INTERVAL \'1\' DAY, ...).\n' +
          '- Money columns are integers in the smallest currency unit (cents); divide by 100.0 for display amounts.\n' +
          '- Timestamps are UTC. Give result columns readable snake_case aliases and add ORDER BY where it helps.\n' +
          '- Add LIMIT 1000 to queries that return individual records rather than aggregates.\n' +
          '- If the question cannot be answered with this schema, return an empty sql and say why in the explanation.\n\n' +
          `# Schema\n${schemaText}`,
        cache_control: { type: 'ephemeral' },
      },
    ];
    let content = `Today is ${new Date().toISOString().slice(0, 10)}.`;
    if (mode === 'edit') {
      const recent = history.slice(-5);
      if (recent.length) {
        content += '\n\nEarlier requests in this conversation:\n' + recent.map((h, i) => `${i + 1}. ${h.prompt}`).join('\n');
      }
      if (currentSql.trim()) content += `\n\nModify this query from the editor:\n\`\`\`sql\n${currentSql}\n\`\`\``;
      if (error) content += `\n\nRunning it failed with this Trino error; fix the query:\n${error}`;
      content += `\n\nChange requested: ${question}`;
    } else {
      content += `\n\nWrite a new query for this question: ${question}`;
    }

    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(Answer) },
      system,
      messages: [{ role: 'user', content }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('The assistant declined to answer this request.');
    }
    const answer = response.parsed_output;
    if (!answer) throw new Error('The assistant returned an unreadable answer. Try rephrasing the question.');
    let sql = answer.sql.trim();
    if (sql) {
      // Never hand the editor something the runner would reject.
      sql = prepareQuery(sql).trim();
    }
    return { sql, explanation: answer.explanation };
  }

  /** Short, editable title for a query (used when a query is first saved). */
  async title(sql) {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(Title) },
      messages: [{ role: 'user', content: `Write a short title (at most 6 words, sentence case, no quotes) for a saved report that runs this SQL:\n\`\`\`sql\n${sql.slice(0, 8000)}\n\`\`\`` }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
    return response.parsed_output.title.trim().slice(0, 80) || null;
  }
}
