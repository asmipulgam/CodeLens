"""One error shape for every non-2xx response: {"code": str, "message": str}. Never a stack trace."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("codelens.errors")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def unauthorized(message: str = "Please sign in again.") -> ApiError:
    return ApiError(401, "unauthorized", message)


def step_up_required() -> ApiError:
    return ApiError(401, "step_up_required", "Please confirm it's you to continue.")


def csrf_failed() -> ApiError:
    return ApiError(403, "csrf_failed", "Security check failed. Refresh the page and try again.")


def forbidden(message: str = "You don't have permission to do that.") -> ApiError:
    return ApiError(403, "forbidden", message)


def not_found(message: str = "Not found.") -> ApiError:
    return ApiError(404, "not_found", message)


def rate_limited() -> ApiError:
    return ApiError(429, "rate_limited", "Too many attempts. Please wait a minute and try again.")


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=status)


_HTTP_CODES = {
    400: ("invalid", "The request was not valid."),
    401: ("unauthorized", "Please sign in again."),
    403: ("forbidden", "You don't have permission to do that."),
    404: ("not_found", "Not found."),
    405: ("method_not_allowed", "That action is not allowed here."),
    413: ("too_large", "The request is too large."),
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Name the fields but never echo the submitted values back.
        fields = sorted({".".join(str(p) for p in err.get("loc", ())[1:]) for err in exc.errors()} - {""})
        detail = f" Check: {', '.join(fields)}." if fields else ""
        return error_response(422, "invalid", "Some of the information sent was not valid." + detail)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code, message = _HTTP_CODES.get(exc.status_code, ("error", "The request could not be completed."))
        return error_response(exc.status_code, code, message)

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error on %s %s", request.method, request.url.path)
        return error_response(500, "internal_error", "Something went wrong on our side. Please try again.")
