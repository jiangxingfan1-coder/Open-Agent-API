import { Fault } from './util.js';

/**
 * A fault that names the request field it is about (OpenAI `error.param`), for layers below the
 * gateway — for example the kernel refusing an image that the chosen agent cannot accept.
 */
export class ParamFault extends Fault {
  constructor(
    code: string,
    message: string,
    status: number,
    public param: string | null,
  ) {
    super(code, message, status);
  }
}
