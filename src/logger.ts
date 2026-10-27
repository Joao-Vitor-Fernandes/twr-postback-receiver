type Fields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

function write(level: string, message: string, fields: Fields = {}): void {
  // Uma linha de JSON por log: fácil de filtrar e de enviar para qualquer coletor.
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));
}

export const jsonLogger: Logger = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
