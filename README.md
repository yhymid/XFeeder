# Requirements
- Node.js
- Webhook URL
- Thread ID (Optional)
- RSSUrls

# Config
![Config](config.json.exemple)
```json
{
  "channels": [
    {
      "Webhook": "Webhook URL Here",
      "Thread": "ThreadID Here",
      "RSS": [
        "URL1",
        "URL2",
        "URL3"
      ],
      "TimeChecker": 30,
      "RequestSend": 5
    },
    {
      "Discord": {
        "Webhook": "Webhook URL Here",
        "Thread": "ThreadID Here",
        "Token": "Discord Account Token Here",
        "x-super-properties": "x-super-properties Here",
        "cookie": "cookie Here",
        "Limit": 50,
        "GuildID": "Guild ID Here",
        "ChannelIDs": [
          "ID1",
          "ID2",
          "ID3"
        ],
      "TimeChecker": 30,
      "RequestSend": 1
      }
    }
  ]
}
```

# How to launch it?
`npm install` <br>
`node main.js`

# Preview
![Preview1](Preview/image.png)
![Preview2](Preview/image2.png)
![Preview3](Preview/image3.png)