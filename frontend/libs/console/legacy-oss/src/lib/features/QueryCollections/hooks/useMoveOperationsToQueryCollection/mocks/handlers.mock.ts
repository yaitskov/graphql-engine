import { rest } from 'msw';

const baseUrl = 'http://localhost:8080';

export const handlers = (delay = 0, url = baseUrl) => [
  // todo export metadata mock based on the input

  rest.post(`${url}/v1/metadata`, (req, res, ctx) => {
    return res(
      ctx.delay(delay),
      ctx.json({
        message: 'success',
      })
    );
  }),
];
