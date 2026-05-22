```markdown
# HermesOps Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the HermesOps Python repository. It covers file naming, import/export styles, commit message conventions, and testing patterns. By following these guidelines, contributors can ensure consistency and maintainability across the codebase.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `dataProcessor.py`, `userManager.py`

### Import Style
- Use **relative imports** within the package.
  - Example:
    ```python
    from .utils import parseData
    from ..models import User
    ```

### Export Style
- Use **named exports** (explicitly listing exported symbols).
  - Example:
    ```python
    __all__ = ['parseData', 'UserManager']
    ```

### Commit Messages
- Use **conventional commit** format with the `feat` prefix for features.
  - Example:
    ```
    feat: add support for user authentication
    ```
- Keep commit messages concise (average ~54 characters).

## Workflows

### Adding a New Feature
**Trigger:** When implementing a new feature.
**Command:** `/add-feature`

1. Create a new Python file using camelCase naming.
2. Write code using relative imports for internal modules.
3. Export key functions/classes using `__all__`.
4. Write or update corresponding test files (`*.test.*`).
5. Commit changes using a conventional commit message with the `feat` prefix.
6. Push changes and open a pull request.

### Writing and Running Tests
**Trigger:** When adding or updating tests.
**Command:** `/run-tests`

1. Create or update test files following the `*.test.*` pattern (e.g., `userManager.test.py`).
2. Write tests using your preferred Python testing framework.
3. Run tests locally to ensure correctness.
4. Commit test changes with a descriptive message.
5. Push changes and review test results.

## Testing Patterns

- Test files follow the `*.test.*` naming convention.
  - Example: `dataProcessor.test.py`
- The specific testing framework is not enforced; use your preferred Python test runner (e.g., `pytest`, `unittest`).
- Place tests alongside the code or in a dedicated tests directory as appropriate.

## Commands
| Command      | Purpose                                    |
|--------------|--------------------------------------------|
| /add-feature | Scaffold and document a new feature addition|
| /run-tests   | Run all test files matching `*.test.*`      |
```