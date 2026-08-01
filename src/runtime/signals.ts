export function onInterrupt(handler: () => void): void {
  const wrapped = (): void => {
    process.off('SIGINT', wrapped);
    handler();
  };
  process.on('SIGINT', wrapped);
}

export function exitOnInterrupt(): void {
  onInterrupt(() => {
    process.stderr.write('Interrupted.\n');
    process.exit(130);
  });
}
