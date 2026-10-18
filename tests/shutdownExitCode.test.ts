process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = 'test-secret';

import { createShutdownController } from '../src/index';

describe('graceful shutdown exit codes (#1558)', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('exits with code 0 on SIGTERM after graceful shutdown', async () => {
    const exit = jest.fn();
    const { onSigterm } = createShutdownController({
      exit,
      closeServer: async () => {},
      closeResources: async () => {},
    });

    onSigterm();
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with code 0 on SIGINT after graceful shutdown', async () => {
    const exit = jest.fn();
    const { onSigint } = createShutdownController({
      exit,
      closeServer: async () => {},
      closeResources: async () => {},
    });

    onSigint();
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with code 1 when shutting down due to an uncaughtException', async () => {
    const exit = jest.fn();
    const { onUncaughtException } = createShutdownController({
      exit,
      closeServer: async () => {},
      closeResources: async () => {},
    });

    onUncaughtException(new Error('fatal boom'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(process.exitCode).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 on unhandledRejection when EXIT_ON_UNHANDLED_REJECTION=true', async () => {
    const exit = jest.fn();
    const { onUnhandledRejection } = createShutdownController({
      exit,
      exitOnUnhandledRejection: true,
      closeServer: async () => {},
      closeResources: async () => {},
    });

    onUnhandledRejection(new Error('unhandled promise error'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not exit on unhandledRejection when EXIT_ON_UNHANDLED_REJECTION=false', async () => {
    const exit = jest.fn();
    const { onUnhandledRejection } = createShutdownController({
      exit,
      exitOnUnhandledRejection: false,
      closeServer: async () => {},
      closeResources: async () => {},
    });

    onUnhandledRejection(new Error('non-fatal promise error'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).not.toHaveBeenCalled();
  });

  it('exits with code 1 if closeServer throws unexpectedly during shutdown', async () => {
    const exit = jest.fn();
    const { onUncaughtException } = createShutdownController({
      exit,
      closeServer: async () => {
        throw new Error('close failed');
      },
      closeResources: async () => {},
    });

    onUncaughtException(new Error('crash'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).toHaveBeenCalledWith(1);
  });
});
