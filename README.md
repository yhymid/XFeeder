# How it works?
This code downloading all info about URLs From RSS/ATOM/XML <br>
And send it to Discord in 2 formats embed and normal message <br>
First format is Embed and this using: RSS/ATOM/XML/FallBack <br>
Second format is normal message and this using: Youtube <br>
And of course this have support Discord Webhook with Threads <br>

# Requirements
- Node.js
- Webhook URL
- Thread ID (Optional)
- RSSUrls

# Config
```json
{
  "channels": [
    {
      "Webhook": "WebhookToFirstChannel",
      "Thread": "ThreadID",
      "RSS": [
        "URL1"
        "URL2"
        "URL3"
      ],
      "TimeChecker": 30,
      "RequestSend": 5
    },
    {
      "Webhook": "WebhookToSecondChannel (If you want)",
      "Thread": "ThreadID",
      "RSS": [
        "URL1"
        "URL2"
        "URL3"
      ],
      "TimeChecker": 30,
      "RequestSend": 5
    }
  ]
}
```

# How to launch it?
`npm install` <br>
`node main.js`

# Preview
![Preview1](.../Preview/image.png)
![Preview2](.../Preview/image2.png)