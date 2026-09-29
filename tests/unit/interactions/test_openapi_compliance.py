"""
OpenAPI compliance tests for Google Interactions API.

Uses the captured provider contract in fixtures/gemini_interactions_contract.json

Run with: pytest tests/unit/interactions/test_openapi_compliance.py -v
"""

from pathlib import Path
from typing import Final
from typing import Any, Dict

import pytest
from jsonschema import Draft202012Validator
from pydantic import JsonValue, TypeAdapter

from litellm.llms.gemini.interactions.transformation import GoogleAIStudioInteractionsConfig
from litellm.types.router import GenericLiteLLMParams


def _load_openapi_spec_dict() -> dict[str, JsonValue]:
    source: Final = Path(__file__).with_name("fixtures") / "gemini_interactions_contract.json"
    return TypeAdapter(dict[str, JsonValue]).validate_json(source.read_bytes())


def _declared_type_value(variant_schema: Dict[str, Any]) -> Any:
    """The single `type` value a union variant pins, whether spelled as a const or a 1-item enum."""
    type_property = variant_schema.get("properties", {}).get("type", {})
    enum_values = type_property.get("enum") or []
    return type_property.get("const") or (enum_values[0] if len(enum_values) == 1 else None)


@pytest.fixture(scope="module")
def spec_dict() -> Dict[str, Any]:
    """Load raw spec dict for manual validation."""
    return _load_openapi_spec_dict()


@pytest.fixture(scope="module")
def request_validator(spec_dict: dict[str, JsonValue]) -> Draft202012Validator:
    schema: Final = {**spec_dict, "$ref": "#/components/schemas/ModelInteraction"}
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


class TestRequestCompliance:
    """Tests that our request bodies match the OpenAPI spec."""

    def test_create_model_interaction_request_schema(self, spec_dict, request_validator: Draft202012Validator):
        """Verify a model request against the captured provider contract."""
        schema = spec_dict["components"]["schemas"]["ModelInteraction"]

        # Required fields per spec
        assert set(schema["required"]) <= schema["properties"].keys()
        assert "model" in schema["required"]
        assert "input" in schema["properties"]
        request: Final = GoogleAIStudioInteractionsConfig().transform_request(
            model="gemini-3.8-flash",
            agent=None,
            input="hello",
            optional_params={"store": False, "stream": False},
            litellm_params=GenericLiteLLMParams(api_key="synthetic-key"),
            headers={},
        )
        assert request == {"model": "gemini-3.8-flash", "input": "hello", "store": False, "stream": False}
        assert request.keys() <= schema["properties"].keys()
        request_validator.validate(request)

        # Check our supported optional fields exist in spec
        our_optional_fields = [
            "tools",
            "system_instruction",
            "generation_config",
            "stream",
            "store",
            "background",
            "response_modalities",
            "response_format",
            "response_mime_type",
            "previous_interaction_id",
        ]

        spec_properties = schema["properties"]
        for field in our_optional_fields:
            assert field in spec_properties, f"Field '{field}' not in OpenAPI spec"
            print(f"✓ Field '{field}' exists in spec")

    def test_input_types_match_spec(self, spec_dict, request_validator: Draft202012Validator):
        """Verify input field supports string, Content, Content[], Turn[]."""
        schema = spec_dict["components"]["schemas"]["ModelInteraction"]
        input_schema = schema["properties"]["input"]

        # The input property may be inline oneOf or a $ref to InteractionsInput
        if "$ref" in input_schema:
            ref_name = input_schema["$ref"].split("/")[-1]
            input_schema = spec_dict["components"]["schemas"][ref_name]

        # Should be oneOf with multiple types
        assert "oneOf" in input_schema

        input_types = []
        for option in input_schema["oneOf"]:
            if option.get("type") == "string":
                input_types.append("string")
            elif option.get("type") == "array":
                input_types.append("array")
            elif "$ref" in option:
                input_types.append(option["$ref"])

        print(f"Input supports types: {input_types}")
        assert "string" in input_types, "Input should support string"
        assert "array" in input_types, "Input should support array"
        for value in ("hello", [{"type": "text", "text": "hello"}]):
            request: Final = GoogleAIStudioInteractionsConfig().transform_request(
                model="gemini-3.8-flash",
                agent=None,
                input=value,
                optional_params={},
                litellm_params=GenericLiteLLMParams(api_key="synthetic-key"),
                headers={},
            )
            assert request["input"] == value
            request_validator.validate(request)

    def test_content_variants_are_identified_by_their_type_field(self, spec_dict):
        """Verify a Content part can be told apart by its `type`, however the spec spells that.

        Our transformation reads `type` off each content part to route it, so what has to hold is
        that every variant of the union pins a distinct `type` value and that text is one of them.
        A spec may express that with an OpenAPI `discriminator` on the union or with a `const` on
        each member's own `type`; both are equivalent for us, so accepting only the first makes
        this test fail on a stylistic change upstream that costs us nothing.
        """
        content_schema = spec_dict["components"]["schemas"]["Content"]

        discriminator = content_schema.get("discriminator")
        if discriminator is not None:
            assert (
                discriminator.get("propertyName") == "type"
            ), f"Content is discriminated on {discriminator.get('propertyName')!r}, not 'type'"

        variant_names = [
            option["$ref"].split("/")[-1]
            for option in content_schema.get("oneOf", [])
            if "$ref" in option
        ]
        assert variant_names, f"Content is not a union of named variants: {content_schema}"

        mapping = (discriminator or {}).get("mapping") or {}
        type_values = {
            variant: mapping_value
            for mapping_value, ref in mapping.items()
            for variant in [ref.split("/")[-1]]
        } or {
            variant: _declared_type_value(spec_dict["components"]["schemas"].get(variant, {}))
            for variant in variant_names
        }

        assert set(type_values) == set(variant_names) and all(type_values.values()), (
            f"every Content variant needs a discoverable type value, "
            f"got {type_values} for variants {sorted(variant_names)}"
        )
        assert len(set(type_values.values())) == len(type_values), (
            f"Content variants must pin DISTINCT type values, got {type_values}"
        )
        assert type_values.get("TextContent") == "text", (
            f"TextContent must be reachable as type 'text', got {type_values}"
        )
        print(f"Content variants by type: {type_values}")

    def test_text_content_schema(self, spec_dict):
        """Verify TextContent schema."""
        text_schema = spec_dict["components"]["schemas"]["TextContent"]

        assert "type" in text_schema["required"]
        assert "text" in text_schema["properties"]
        assert text_schema["properties"]["type"].get("const") == "text"
        print("✓ TextContent schema is correct")

    def test_step_schema(self, spec_dict):
        """Verify step-based multi-turn input.

        Google replaced the role-carrying `Turn` schema with typed steps
        (spec update of Aug 13, 2026): conversation history is now a `Step[]`
        where `UserInputStep`/`ModelOutputStep` pin `type` values that our
        transformations read to recover the role. Assert exactly what our code
        depends on: `InteractionsInput` accepts a Step array, both step kinds
        are part of the `Step` union, each pins its `type` const, and each
        carries a `Content[]` content field.
        """
        input_schema = spec_dict["components"]["schemas"]["InteractionsInput"]
        step_array_items = [
            option["items"]["$ref"].split("/")[-1]
            for option in input_schema["oneOf"]
            if option.get("type") == "array" and "$ref" in option.get("items", {})
        ]
        assert "Step" in step_array_items, f"InteractionsInput should accept Step[], got arrays of {step_array_items}"

        step_variants = {
            option["$ref"].split("/")[-1]
            for option in spec_dict["components"]["schemas"]["Step"]["oneOf"]
            if "$ref" in option
        }
        assert {"UserInputStep", "ModelOutputStep"} <= step_variants, f"Step union is missing role steps: {step_variants}"

        for step_name, type_value in [("UserInputStep", "user_input"), ("ModelOutputStep", "model_output")]:
            step_schema = spec_dict["components"]["schemas"][step_name]
            assert step_schema["properties"]["type"].get("const") == type_value
            assert "type" in step_schema["required"]
            content_items = step_schema["properties"]["content"]["items"]
            assert content_items["$ref"].split("/")[-1] == "Content"
            print(f"✓ {step_name} pins type '{type_value}' with Content[] content")


class TestResponseCompliance:
    """Tests that our response types match the OpenAPI spec."""

    def test_interaction_response_fields(self, spec_dict):
        """Verify our InteractionsAPIResponse has correct fields."""
        schema = spec_dict["components"]["schemas"]["Interaction"]

        output_fields = [
            "id",
            "status",
            "created",
            "updated",
            "steps",
            "usage",
        ]

        for field in output_fields:
            assert field in schema["properties"], f"Output field '{field}' not in spec"
            print(f"✓ Output field '{field}' exists in spec")

    def test_status_enum_values(self, spec_dict):
        """Verify status enum values match spec."""
        # `status` is an output-only field; validate against the response schema.
        schema = spec_dict["components"]["schemas"]["Interaction"]
        status_prop = schema["properties"]["status"]
        expected_statuses = [
            "in_progress",
            "requires_action",
            "completed",
            "failed",
            "cancelled",
            "incomplete",
            "budget_exceeded",
            "queued",
        ]
        assert status_prop["enum"] == expected_statuses
        print(f"✓ Status enum values: {expected_statuses}")

    def test_usage_schema(self, spec_dict):
        """Verify Usage schema fields."""
        usage_schema = spec_dict["components"]["schemas"]["Usage"]

        # Key usage fields
        expected_fields = ["total_input_tokens", "total_output_tokens", "total_tokens"]

        for field in expected_fields:
            assert (
                field in usage_schema["properties"]
            ), f"Usage field '{field}' not in spec"
            print(f"✓ Usage field '{field}' exists")


class TestToolsCompliance:
    """Tests that our tool types match the OpenAPI spec."""

    def test_tool_schema(self, spec_dict):
        """Verify Tool schema."""
        tool_schema = spec_dict["components"]["schemas"]["Tool"]

        # Tool should be oneOf multiple tool types
        assert "oneOf" in tool_schema or "properties" in tool_schema
        print(f"✓ Tool schema found")

    def test_function_declaration_schema(self, spec_dict):
        """Verify FunctionDeclaration schema for function tools."""
        if "FunctionDeclaration" in spec_dict["components"]["schemas"]:
            func_schema = spec_dict["components"]["schemas"]["FunctionDeclaration"]
            assert "name" in func_schema.get(
                "properties", {}
            ) or "name" in func_schema.get("required", [])
            print("✓ FunctionDeclaration schema found")
        else:
            print("⚠ FunctionDeclaration schema not found (may be nested)")


class TestEndpointCompliance:
    """Tests that our endpoints match the OpenAPI spec."""

    def test_create_endpoint_exists(self, spec_dict):
        """Verify POST /interactions endpoint exists."""
        paths = spec_dict["paths"]

        # Find the create interactions endpoint
        create_path = None
        for path, methods in paths.items():
            if "interactions" in path and "post" in methods:
                create_path = path
                break

        assert create_path is not None, "POST /interactions endpoint not found"
        print(f"✓ Create endpoint: POST {create_path}")

    def test_get_endpoint_exists(self, spec_dict):
        """Verify GET /interactions/{id} endpoint exists."""
        paths = spec_dict["paths"]

        get_path = None
        for path, methods in paths.items():
            if "/interactions/{" in path and path.endswith("}") and "get" in methods:
                get_path = path
                break

        assert get_path is not None, "GET /interactions/{id} endpoint not found"
        url, params = GoogleAIStudioInteractionsConfig().transform_get_interaction_request(
            interaction_id="contract-id",
            api_base="https://generativelanguage.googleapis.com",
            litellm_params=GenericLiteLLMParams(api_key="synthetic-key"),
            headers={},
        )
        expected_path: Final = get_path.replace("{api_version}", "v1beta").rsplit("/", 1)[0] + "/contract-id"
        assert url == "https://generativelanguage.googleapis.com" + expected_path
        assert params == {}
        print(f"✓ Get endpoint: GET {get_path}")

    def test_delete_endpoint_exists(self, spec_dict):
        """Verify DELETE /interactions/{id} endpoint exists."""
        paths = spec_dict["paths"]

        delete_path = None
        for path, methods in paths.items():
            if "/interactions/{" in path and path.endswith("}") and "delete" in methods:
                delete_path = path
                break

        assert delete_path is not None, "DELETE /interactions/{id} endpoint not found"
        url, params = GoogleAIStudioInteractionsConfig().transform_delete_interaction_request(
            interaction_id="contract-id",
            api_base="https://generativelanguage.googleapis.com",
            litellm_params=GenericLiteLLMParams(api_key="synthetic-key"),
            headers={},
        )
        expected_path: Final = delete_path.replace("{api_version}", "v1beta").rsplit("/", 1)[0] + "/contract-id"
        assert url == "https://generativelanguage.googleapis.com" + expected_path
        assert params == {}
        print(f"✓ Delete endpoint: DELETE {delete_path}")
