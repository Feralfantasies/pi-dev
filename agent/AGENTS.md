# Project Instructions

- **Mandatory Web Search:** When implementing new features, using unfamiliar libraries, or calling external APIs, you MUST use the `web_search` tool to find the most up-to-date official documentation and code examples before writing any code.
- Do not rely solely on your internal training data for API syntax, use the web_read tool to fetch the raw markdown of relevant documentation pages before writing any code.
- If you encounter a bug or error, use the web search tool to look for community solutions or issue trackers.

## Networking

- **Traefik Debugging:** To diagnose routing or proxy issues, you can view Traefik's live computed state by running `curl -s http://192.168.1.2:8080/api/rawdata | jq`. Look for errors in the "routers" or "services" blocks.
- **Traefik Configuration:** When checking how traffic is routed into the cluster, inspect the desired state using `kubectl get ingressroutes,middlewares,traefikservices -A -o yaml`.
