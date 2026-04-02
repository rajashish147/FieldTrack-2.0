import { describe, it, expect } from "vitest";
import {
  AppError,
  UnauthorizedError,
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  EmployeeAlreadyCheckedIn,
  SessionAlreadyClosed,
  ExpenseAlreadyReviewed,
} from "../../../src/utils/errors.js";

// ─── AppError base class ──────────────────────────────────────────────────────

describe("AppError", () => {
  it("extends Error", () => {
    expect(new AppError("test", 400)).toBeInstanceOf(Error);
  });

  it("stores statusCode", () => {
    expect(new AppError("msg", 422).statusCode).toBe(422);
  });

  it("stores message", () => {
    expect(new AppError("custom message", 400).message).toBe("custom message");
  });
});

// ─── HTTP status error subclasses ─────────────────────────────────────────────

describe("UnauthorizedError", () => {
  it("has statusCode 401", () => {
    expect(new UnauthorizedError().statusCode).toBe(401);
  });

  it("has default message", () => {
    expect(new UnauthorizedError().message).toBe("Unauthorized");
  });

  it("accepts custom message", () => {
    expect(new UnauthorizedError("Token expired").message).toBe("Token expired");
  });
});

describe("NotFoundError", () => {
  it("has statusCode 404", () => {
    expect(new NotFoundError().statusCode).toBe(404);
  });

  it("is instanceof AppError", () => {
    expect(new NotFoundError()).toBeInstanceOf(AppError);
  });
});

describe("BadRequestError", () => {
  it("has statusCode 400", () => {
    expect(new BadRequestError().statusCode).toBe(400);
  });
});

describe("ForbiddenError", () => {
  it("has statusCode 403", () => {
    expect(new ForbiddenError().statusCode).toBe(403);
  });
});

// ─── Domain error classes ─────────────────────────────────────────────────────

describe("EmployeeAlreadyCheckedIn", () => {
  it("has statusCode 400", () => {
    expect(new EmployeeAlreadyCheckedIn().statusCode).toBe(400);
  });

  it("is instanceof BadRequestError", () => {
    expect(new EmployeeAlreadyCheckedIn()).toBeInstanceOf(BadRequestError);
  });

  it("is instanceof AppError", () => {
    expect(new EmployeeAlreadyCheckedIn()).toBeInstanceOf(AppError);
  });

  it("message mentions active session", () => {
    expect(new EmployeeAlreadyCheckedIn().message).toContain("active session");
  });
});

describe("SessionAlreadyClosed", () => {
  it("has statusCode 400", () => {
    expect(new SessionAlreadyClosed().statusCode).toBe(400);
  });

  it("is instanceof BadRequestError", () => {
    expect(new SessionAlreadyClosed()).toBeInstanceOf(BadRequestError);
  });

  it("message mentions check in", () => {
    expect(new SessionAlreadyClosed().message.toLowerCase()).toContain(
      "check in",
    );
  });
});

describe("ExpenseAlreadyReviewed", () => {
  it("has statusCode 400", () => {
    expect(new ExpenseAlreadyReviewed("APPROVED").statusCode).toBe(400);
  });

  it("is instanceof BadRequestError", () => {
    expect(new ExpenseAlreadyReviewed("REJECTED")).toBeInstanceOf(
      BadRequestError,
    );
  });

  it("includes the current status in the message", () => {
    expect(new ExpenseAlreadyReviewed("APPROVED").message).toContain(
      "approved",
    );
    expect(new ExpenseAlreadyReviewed("REJECTED").message).toContain(
      "rejected",
    );
  });

  it("mentions PENDING in the message", () => {
    expect(new ExpenseAlreadyReviewed("APPROVED").message).toContain("PENDING");
  });
});
