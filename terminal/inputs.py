from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Login(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


class Metadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="", min_length=1, max_length=80)
    group: str = Field(default="", max_length=40)
    tags: list[str] = Field(default_factory=list, max_length=8)
    pinned: bool = Field(default=False, strict=True)
    note: str = Field(default="", max_length=500)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("会话名称不能为空或包含控制字符")
        return value

    @field_validator("group")
    @classmethod
    def clean_group(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("分组不能包含控制字符")
        return value.strip()

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, values: list[str]) -> list[str]:
        tags = list(dict.fromkeys(value.strip() for value in values))
        if any(not tag or len(tag) > 24 or any(ord(c) < 32 for c in tag) for tag in tags):
            raise ValueError("标签需要为 1–24 个字符，不含控制字符")
        return tags


class Create(Metadata):
    name: str = Field(min_length=1, max_length=80)
    shell: str
    cwd: str = Field(min_length=1, max_length=4096)


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[str] = Field(min_length=1, max_length=256)
    action: Literal["close", "group", "pin", "unpin"]
    group: str = Field(default="", max_length=40)

    @field_validator("ids")
    @classmethod
    def unique_ids(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))

    @field_validator("group")
    @classmethod
    def clean_group(cls, value: str) -> str:
        return Metadata.clean_group(value)


class Split(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pane: str = Field(pattern=r"^%\d+$", max_length=24)
    direction: Literal["horizontal", "vertical"]


class PaneAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pane: str = Field(pattern=r"^%\d+$", max_length=24)
    action: Literal["select", "zoom", "restart"]
