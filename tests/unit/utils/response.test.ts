import { describe, it, expect, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { ok, fail, handleError } from "../../../src/utils/response.js";
import {
  AppError,
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from "../../../src/utils/errors.js";
import { ZodError } from "zod";
import { z } from "zod";

// ─── ok() ─────────────────────────────────────────────────────────────────────

describe("ok()", () => {
  it("wraps data in a success envelope", () => {
    const result = ok({ id: "abc", name: "Test" });
    expect(result).toEqual({ success: true, data: { id: "abc", name: "Test" } });
  });

  it("sets success to true", () => {
    expect(ok(null).success).toBe(true);
  });

  it("passes through arrays", () => {
    const data = [1, 2, 3];
    expect(ok(data).data).toEqual([1, 2, 3]);
  });

  it("passes through null", () => {
    expect(ok(null)).toEqual({ success: true, data: null });
  });
});

// ─── fail() ──────────────────────────────────────────────────────────────────

describe("fail()", () => {
  it("wraps an error message in an error envelope", () => {
    const result = fail("Something went wrong", "req-123");
    expect(result).toEqual({
      success: false,
      error: "Something went wrong",
      requestId: "req-123",
    });
  });

  it("sets success to false", () => {
    expect(fail("err", "id").success).toBe(false);
  });

  it("preserves the requestId", () => {
    const id = "my-unique-request-id";
    expect(fail("err", id).requestId).toBe(id);
  });
});

// ─── handleError() ───────────────────────────────────────────────────────────

function makeFakeReply() {
  const sent: Array<{ status: number; body: unknown }> = [];
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockImplementation((body) => {
      sent.push({ status: (reply.status as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as number, body });
      return reply;
    }),
    getSent: () => sent,
  } as unknown as FastifyReply & { getSent: () => Array<{ status: number; body: unknown }> };
  return reply;
}

function makeFakeRequest(id = "test-req-id") {
  return {
    id,
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  } as unknown as FastifyRequest;
}

describe("handleError()", () => {
  it("maps AppError to its statusCode", () => {
    const reply = makeFakeReply();
    const request = makeFakeRequest();
    try { handleError(new NotFoundError("Item not found"), request, reply, "ctx"); } catch (_) {}
    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: "Item not found" }),
    );
  });

  it("maps BadRequestError to 400", () => {
    const reply = makeFakeReply();
    try { handleError(new BadRequestError("bad"), makeFakeRequest(), reply, "ctx"); } catch (_) {}
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("maps ForbiddenError to 403", () => {
    const reply = makeFakeReply();
    try { handleError(new ForbiddenError(), makeFakeRequest(), reply, "ctx"); } catch (_) {}
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it("maps ZodError to 400 with joined issue messages", () => {
    const reply = makeFakeReply();
    const request = makeFakeRequest();
    let zodError: ZodError | undefined;
    try {
      z.object({ name: z.string().min(3) }).parse({ name: "x" });
    } catch (e) {
      zodError = e as ZodError;
    }
    try { handleError(zodError!, request, reply, "ctx"); } catch (_) {}
    expect(reply.status).toHaveBeenCalledWith(400);
    const body = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      error: string;
    };
    expect(body.error).toContain("Validation failed");
  });

  it("maps unknown errors to 500 and logs them", () => {
    const reply = makeFakeReply();
    const request = makeFakeRequest();
    try { handleError(new Error("boom"), request, reply, "test context"); } catch (_) {}
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(
      (request.log.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[1],
    ).toBe("test context");
  });

  it("includes requestId in every error response", () => {
    const reply = makeFakeReply();
    const request = makeFakeRequest("my-req");
    try { handleError(new AppError("oops", 422), request, reply, "ctx"); } catch (_) {}
    const body = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      requestId: string;
    };
    expect(body.requestId).toBe("my-req");
  });
});
