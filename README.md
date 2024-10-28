# Description

Collaborate with [GitHub Copilot](https://code.visualstudio.com/docs/copilot/overview) to create [Mermaid](https://mermaid.js.org/intro/) diagrams through the chat participant, `@mermAId`.

[Sign up for a GitHub Copilot free trial](https://github.com/settings/copilot)

## Features

1. The chat participant `mermAId` which will create mermaid based diagrams and allow you to iterate on them.
2. Chat tools, used by the participant, that will gather context about your code to create more detailed and accurate diagrams.
3. A new Outline view that will generate a diagram based on the outline of each file.
4. Diagrams can be viewed as the rendered SVG or the source mermaid code.
5. Links can be automatically injected into the diagram to navigate to the related code.

## Extension Settings

- `mermaid.searchForExtensions`: Search for Mermaid extensions when viewing Mermaid source.
- `mermaid.enableGroq`: **Experimental**: Enable outline generation with [groq](https://groq.com/). Requires an API key from groq.

## Using groq

1. use the command `copilot mermAId: Store groq API key` to add your groq api key
2. go to the outline view and click the refresh button
3. you should be able to see in the mermAId logs that the groq API is set
4. to disable even with the key set use the setting `mermaid.enableGroq`
5. groq API key is store in extension secrets, may not persist always so check if you think there is an issue
