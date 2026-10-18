import { Request, Response, NextFunction } from 'express';
import * as sep10 from '../../src/services/sep10';
import { Sep10Error, type Sep10ErrorCode } from '../../src/services/sep10';
import { postToken, SEP10_ERROR_HTTP_MAP } from '../../src/controllers/authController';
import { ErrorCode } from '../../src/utils/errorCodes';

describe('postToken authentication errors (#1518)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeReqRes(transaction = 'dummy-xdr') {
    const req = {
      body: { transaction },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;
    return { req, res, next };
  }

  it.each([
    ['INVALID_SIGNATURE', 'Invalid challenge signature', 401, ErrorCode.TOKEN_INVALID],
    ['CHALLENGE_EXPIRED', 'Challenge has expired', 401, ErrorCode.TOKEN_EXPIRED],
    ['WRONG_SOURCE', 'Challenge source account is not the server account', 401, ErrorCode.TOKEN_INVALID],
    ['BAD_SEQUENCE', 'Challenge sequence number must be 0', 401, ErrorCode.TOKEN_INVALID],
    ['MISSING_TIMEBOUNDS', 'Challenge must have time bounds', 401, ErrorCode.TOKEN_INVALID],
    ['FUTURE_MINTIME', 'Challenge minTime is in the future', 401, ErrorCode.TOKEN_INVALID],
    ['MISSING_OPERATIONS', 'Invalid challenge: no operations found', 401, ErrorCode.TOKEN_INVALID],
    ['INVALID_OPERATION', 'Invalid challenge operation', 401, ErrorCode.TOKEN_INVALID],
    ['INVALID_NONCE', 'Invalid challenge nonce', 401, ErrorCode.TOKEN_INVALID],
    ['MISSING_CLIENT_SOURCE', 'Missing source account in challenge', 401, ErrorCode.TOKEN_INVALID],
    ['NOT_SIGNED_BY_SERVER', 'Challenge not signed by server', 401, ErrorCode.TOKEN_INVALID],
    ['CHALLENGE_REPLAYED', 'Challenge has already been used', 401, ErrorCode.TOKEN_INVALID],
    ['MALFORMED_XDR', 'Malformed challenge transaction XDR', 400, ErrorCode.VALIDATION_ERROR],
  ] as Array<[Sep10ErrorCode, string, number, ErrorCode]>)(
    'maps Sep10Error(%s) to HTTP %i and code %s',
    (sep10Code, expectedClientMessage, expectedStatus, expectedErrorCode) => {
      jest.spyOn(sep10, 'verifyChallenge').mockImplementation(() => {
        throw new Sep10Error(sep10Code, `Internal detail for ${sep10Code}: SDK raw text`);
      });

      const { req, res, next } = makeReqRes();
      postToken(req, res, next);

      expect(res.status).toHaveBeenCalledWith(expectedStatus);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expectedClientMessage,
        code: expectedErrorCode,
      });
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('does not leak raw SDK exception text on MALFORMED_XDR', () => {
    jest.spyOn(sep10, 'verifyChallenge').mockImplementation(() => {
      throw new Sep10Error('MALFORMED_XDR', 'XDR Read Error: Operation union switch 999 at offset 42');
    });

    const { req, res, next } = makeReqRes();
    postToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(payload.error).toBe(SEP10_ERROR_HTTP_MAP.MALFORMED_XDR.clientMessage);
    expect(payload.error).not.toContain('XDR Read Error');
    expect(payload.error).not.toContain('offset 42');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes unexpected non-Sep10Error exceptions to next(err) for 500 handling', () => {
    const unexpected = new Error('Unexpected internal Operation failure');
    jest.spyOn(sep10, 'verifyChallenge').mockImplementation(() => {
      throw unexpected;
    });

    const { req, res, next } = makeReqRes();
    postToken(req, res, next);

    expect(next).toHaveBeenCalledWith(unexpected);
    expect(res.status).not.toHaveBeenCalled();
  });
});
