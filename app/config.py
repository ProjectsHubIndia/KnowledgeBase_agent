import secrets

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # LLM (OpenAI) — used for invoice extraction and the query agent.
    llm_api_key: str = Field(validation_alias="LLM_API_KEY")
    llm_model: str = "gpt-4o-mini"

    # LLM call resilience
    llm_max_retries: int = 5
    llm_max_retry_wait: float = 35.0

    # Where extracted invoice markdown files are stored (one file per invoice).
    invoice_dir: str = "invoice_data"

    # Max invoices extracted in parallel during a bulk upload (each is one LLM
    # call — this bounds concurrency so we don't hammer the provider).
    bulk_concurrency: int = 8

    # Database (Postgres) — only conversation sessions/messages live here.
    database_url: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:9432/agentvector"
    )

    # Bootstrap admin — seeded into the users table on first startup only.
    # Existing deployments keep working with the .env they already have.
    auth_username: str = Field(validation_alias="AUTH_USERNAME")
    auth_password: str = Field(validation_alias="AUTH_PASSWORD")

    # JWT signing. Set JWT_SECRET in .env to keep tokens valid across restarts;
    # if unset we generate a per-process secret (everyone is logged out on
    # restart, but the app still boots — important for existing installs).
    jwt_secret: str = Field(
        default_factory=lambda: secrets.token_urlsafe(48),
        validation_alias="JWT_SECRET",
    )
    jwt_ttl_hours: int = 12

    @field_validator("jwt_secret")
    @classmethod
    def _secret_must_not_be_blank(cls, value: str) -> str:
        """An empty JWT_SECRET= line in .env would otherwise sign tokens with an
        empty key — fall back to a random per-process secret instead."""
        return value.strip() or secrets.token_urlsafe(48)

    # Conversation sessions
    history_turns: int = 6  # how many prior user/assistant turns to replay

    # Cap on how much of a single invoice file is fed to the agent per read.
    read_char_limit: int = 8000

    # Cap on how much of a finance document is fed to the agent per read.
    doc_read_char_limit: int = 16000


settings = Settings()
