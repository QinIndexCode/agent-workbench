import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { BackendNewRuntime } from '../../application/create-runtime';

export interface HttpRouteContext {
  runtime: BackendNewRuntime;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  path: string;
  segments: string[];
}

export interface HttpRouteModule {
  handle(context: HttpRouteContext): Promise<boolean>;
}
