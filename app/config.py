from pydantic import Field
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

    # Shared login for the web app + API (single account, no user table).
    auth_username: str = Field(validation_alias="AUTH_USERNAME")
    auth_password: str = Field(validation_alias="AUTH_PASSWORD")

    # Conversation sessions
    history_turns: int = 6  # how many prior user/assistant turns to replay

    # Cap on how much of a single invoice file is fed to the agent per read.
    read_char_limit: int = 8000

    # Cap on how much of a finance document is fed to the agent per read.
    doc_read_char_limit: int = 16000


settings = Settings()
