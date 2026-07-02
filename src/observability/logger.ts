type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, ctx?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    agent: 'governance',
    msg,
    ...ctx,
  };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
};
