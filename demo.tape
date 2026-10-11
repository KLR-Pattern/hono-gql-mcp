# Demo tape for hono-gql-mcp — render with:  vhs demo.tape
# (vhs needs ttyd + ffmpeg; install from https://github.com/charmbracelet/vhs)
# Output: demo.gif — drop it into docs/ and reference it from the README.

Output demo.gif
Set FontSize 16
Set Width 1200
Set Height 640
Set Theme "Catppuccin Mocha"
TypingSpeed 12ms

# Boot the demo (a plain REST app + the bridge derived from it)
Type@500ms "npm run example:sink &"
Enter
Sleep 3s

Type@500ms "clear"
Enter
Sleep 300ms

# 1. The constant tool set: 22 REST routes → THREE tools, not 22
Type@500ms `curl -s localhost:8110/mcp -X POST -H 'content-type: application/json' \`
Type `-H 'accept: application/json, text/event-stream' \`
Type `-H 'host: localhost:8110' \`
Enter
Type `-d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}' > /dev/null`
Enter
Sleep 800ms
Type `curl -s localhost:8110/mcp -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'host: localhost:8110' \`
Enter
Type `-d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq -r '.result.tools[].name'`
Enter
Sleep 800ms

# 2. One tool call composes routes across THREE domains
Type@500ms `curl -s localhost:8110/mcp -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'host: localhost:8110' \`
Enter
Type `-d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"graphql_query","arguments":{"query":"{ users { list_users(per_page: 2) { email } } shop { catalog { list_items { sku qty } } } misc { ping } }"}}}' | jq -c '.result.content[0].text' | jq fromjson | jq '.data'`
Enter
Sleep 900ms

# 3. Partial failure: a 404 route nulls itself, siblings survive
Type@500ms `curl -s localhost:8110/mcp -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'host: localhost:8110' \`
Enter
Type `-d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"graphql_query","arguments":{"query":"{ users { get_user(id: \\"nope\\") { email }  list_users(per_page: 1) { email } } }"}}}' | jq fromjson | jq '.errors[0].message, .data.users.list_users'`
Enter
Sleep 5s
