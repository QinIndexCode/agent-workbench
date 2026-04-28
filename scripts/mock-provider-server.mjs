import http from 'node:http';
import process from 'node:process';

const port = Number.parseInt(process.env.MOCK_PROVIDER_PORT ?? '4011', 10);
let responses = [];

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

function normalizeQueuedResponse(entry) {
  if (typeof entry === 'string') {
    return {
      content: entry,
      statusCode: 200,
      delayMs: 0
    };
  }
  if (!entry || typeof entry !== 'object') {
    throw new Error('Queued provider response must be a string or object.');
  }
  if (typeof entry.error === 'string') {
    return {
      error: entry.error,
      statusCode: Number(entry.statusCode ?? 500),
      delayMs: Number(entry.delayMs ?? 0)
    };
  }
  return {
    content: String(entry.content ?? ''),
    statusCode: Number(entry.statusCode ?? 200),
    delayMs: Number(entry.delayMs ?? 0)
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        queuedResponses: responses.length
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/__admin/reset') {
      const payload = await readJson(request);
      responses = Array.isArray(payload.responses)
        ? payload.responses.map((entry) => normalizeQueuedResponse(entry))
        : [];
      sendJson(response, 200, {
        ok: true,
        queuedResponses: responses.length
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (responses.length === 0) {
        sendJson(response, 500, {
          error: {
            message: 'mock provider queue is empty'
          }
        });
        return;
      }
      const next = responses.shift();
      if (next.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, next.delayMs));
      }
      if (next.error) {
        sendJson(response, next.statusCode, {
          error: {
            message: next.error
          }
        });
        return;
      }
      sendJson(response, next.statusCode, {
        id: `mock_${Date.now()}`,
        object: 'chat.completion',
        model: 'mock-e2e-model',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: next.content
            }
          }
        ],
        usage: {
          prompt_tokens: 32,
          completion_tokens: Math.max(8, Math.ceil(next.content.length / 4)),
          total_tokens: 32 + Math.max(8, Math.ceil(next.content.length / 4))
        }
      });
      return;
    }

    sendJson(response, 404, {
      error: {
        message: `unknown mock provider route: ${request.method} ${url.pathname}`
      }
    });
  } catch (error) {
    sendJson(response, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({
    ok: true,
    port
  }));
});

