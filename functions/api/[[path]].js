import { handleRequest } from "../lib/api.js";

export function onRequest(context) {
  return handleRequest(context.request, context.env);
}
