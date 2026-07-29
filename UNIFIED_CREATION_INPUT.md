# Unified Creation Input

`CreationInputController` owns the physical pointer lifecycle for every creation tool:

- `begin(context, session, input)`
- `move(context, session, input)`
- `end(context, session, input)`
- `cancel(context, session, input, reason)`

The selected tool is read only when a new physical contact begins. If the toolbar changes while a contact is active, that contact finishes with its original tool and the next contact starts with the newly selected tool.

To add another drawing tool, register another adapter in `unifiedCreationTools` in `Board.jsx`. The adapter must use the same four methods. It must not add its own `pointerdown`, `pointermove`, `pointerup`, delays, or synthetic tool-switch events.

Persistence, realtime, and delayed finalization belong inside the tool adapter and must not keep the controller's active physical session occupied after `end` or `cancel` returns.
