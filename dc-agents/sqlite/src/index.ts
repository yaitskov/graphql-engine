import Fastify from 'fastify';
import FastifyCors from '@fastify/cors';
import { getSchema } from './schema';
import { explain, queryData } from './query';
import { getConfig, tryGetConfig } from './config';
import { capabilitiesResponse } from './capabilities';
import { QueryResponse, SchemaResponse, QueryRequest, CapabilitiesResponse, ExplainResponse, RawRequest, RawResponse, ErrorResponse } from '@hasura/dc-api-types';
import { connect } from './db';
import { envToBool, envToString } from './util';
import metrics from 'fastify-metrics';
import prometheus from 'prom-client';
import * as fs from 'fs'
import { runRawOperation } from './raw';

const port = Number(process.env.PORT) || 8100;

// NOTE: Pretty printing for logs is no longer supported out of the box.
// See: https://github.com/pinojs/pino-pretty#integration
// Pretty printed logs will be enabled if you have the `pino-pretty`
// dev dependency installed as per the package.json settings.
const server = Fastify({
  logger:
    {
      level: envToString("LOG_LEVEL", "info"),
      ...(
        (envToBool('PRETTY_PRINT_LOGS'))
          ? { transport: { target: 'pino-pretty' } }
          : {}
      )
    }
})

server.setErrorHandler(function (error, _request, reply) {
  // Log error
  this.log.error(error)

  const errorResponse: ErrorResponse = {
    type: "uncaught-error",
    message: "SQLite Agent: Uncaught Exception",
    details: error
  };

  // Send error response
  reply.status(500).send(errorResponse);
})

const METRICS_ENABLED = envToBool('METRICS');

if(METRICS_ENABLED) {
  // See: https://www.npmjs.com/package/fastify-metrics
  server.register(metrics, {
    endpoint: '/metrics',
    routeMetrics: {
      enabled: true,
      registeredRoutesOnly: false,
    }
  });
}

if(envToBool('PERMISSIVE_CORS')) {
  // See: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin
  server.register(FastifyCors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["X-Hasura-DataConnector-Config", "X-Hasura-DataConnector-SourceName"]
  });
}

// Register request-hook metrics.
// This is done in a closure so that the metrics are scoped here.
(() => {
  if(! METRICS_ENABLED) {
    return;
  }

  const requestCounter = new prometheus.Counter({
    name: 'http_request_count',
    help: 'Number of requests',
    labelNames: ['route'],
  });

  // Register a global request counting metric
  // See: https://www.fastify.io/docs/latest/Reference/Hooks/#onrequest
  server.addHook('onRequest', async (request, reply) => {
    requestCounter.inc({route: request.routerPath});
  })
})();

// Serves as an example of a custom histogram
// Not especially useful at present as this mirrors
// http_request_duration_seconds_bucket but is less general
// but the query endpoint will offer more statistics specific
// to the database interactions in future.
const queryHistogram = new prometheus.Histogram({
  name: 'query_durations',
  help: 'Histogram of the duration of query response times.',
  buckets: prometheus.exponentialBuckets(0.0001, 10, 8),
  labelNames: ['route'] as const,
});

const sqlLogger = (sql: string): void => {
  server.log.debug({sql}, "Executed SQL");
};

// NOTE:
// 
// While an ErrorResponse is available it is not currently used as there are no errors anticipated.
// It is included here for illustrative purposes.
// 
server.get<{ Reply: CapabilitiesResponse | ErrorResponse }>("/capabilities", async (request, _response) => {
  server.log.info({ headers: request.headers, query: request.body, }, "capabilities.request");
  return capabilitiesResponse;
});

server.get<{ Reply: SchemaResponse }>("/schema", async (request, _response) => {
  server.log.info({ headers: request.headers, query: request.body, }, "schema.request");
  const config = getConfig(request);
  return getSchema(config, sqlLogger);
});

server.post<{ Body: QueryRequest, Reply: QueryResponse | ErrorResponse }>("/query", async (request, response) => {
  server.log.info({ headers: request.headers, query: request.body, }, "query.request");
  const end = queryHistogram.startTimer()
  const config = getConfig(request);
  const result : QueryResponse | ErrorResponse = await queryData(config, sqlLogger, request.body);
  end();
  if("message" in result) {
    response.statusCode = 500;
  }
  return result;
});

// TODO: Use derived types for body and reply
server.post<{ Body: RawRequest, Reply: RawResponse }>("/raw", async (request, _response) => {
  server.log.info({ headers: request.headers, query: request.body, }, "schema.raw");
  const config = getConfig(request);
  return runRawOperation(config, sqlLogger, request.body);
});

server.post<{ Body: QueryRequest, Reply: ExplainResponse}>("/explain", async (request, _response) => {
  server.log.info({ headers: request.headers, query: request.body, }, "query.request");
  const config = getConfig(request);
  return explain(config, sqlLogger, request.body);
});

server.get("/health", async (request, response) => {
  const config = tryGetConfig(request);
  response.type('application/json');

  if(config === null) {
    server.log.info({ headers: request.headers, query: request.body, }, "health.request");
    response.statusCode = 204;
  } else {
    server.log.info({ headers: request.headers, query: request.body, }, "health.db.request");
    const db = connect(config, sqlLogger);
    const [r, m] = await db.query('select 1 where 1 = 1');
    if(r && JSON.stringify(r) == '[{"1":1}]') {
      response.statusCode = 204;
    } else {
      response.statusCode = 500;
      return { "error": "problem executing query", "query_result": r };
    }
  }
});

server.get("/swagger.json", async (request, response) => {
  fs.readFile('src/types/agent.openapi.json', (err, fileBuffer) => {
    response.type('application/json');
    response.send(err || fileBuffer)
  })
})

server.get("/", async (request, response) => {
  response.type('text/html');
  return `<!DOCTYPE html>
    <html>
      <head>
        <title>Hasura Data Connectors SQLite Agent</title>
      </head>
      <body>
        <h1>Hasura Data Connectors SQLite Agent</h1>
        <p>See <a href="https://github.com/hasura/graphql-engine#hasura-graphql-engine">
          the GraphQL Engine repository</a> for more information.</p>
        <ul>
          <li><a href="/">GET / - This Page</a>
          <li><a href="/capabilities">GET /capabilities - Capabilities Metadata</a>
          <li><a href="/schema">GET /schema - Agent Schema</a>
          <li><a href="/query">POST /query - Query Handler</a>
          <li><a href="/raw">POST /raw - Raw Query Handler</a>
          <li><a href="/health">GET /health - Healthcheck</a>
          <li><a href="/swagger.json">GET /swagger.json - Swagger JSON</a>
          <li><a href="/metrics">GET /metrics - Prometheus formatted metrics</a>
        </ul>
      </body>
    </html>
  `;
})

process.on('SIGINT', () => {
  server.log.info("interrupted");
  process.exit(0);
});

const start = async () => {
  try {
    server.log.info(`STARTING on port ${port}`);
    await server.listen({port: port, host: "0.0.0.0"});
  }
  catch (err) {
    server.log.fatal(err);
    process.exit(1);
  }
};
start();
