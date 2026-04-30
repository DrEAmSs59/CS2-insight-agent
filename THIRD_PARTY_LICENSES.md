# Third-Party Licenses

CS2 Insight Agent 在编译与运行时依赖以下开源组件。所有依赖均使用宽松型许可证（MIT / BSD / Apache-2.0 / ISC），与本项目使用的 **PolyForm Noncommercial 1.0.0** 兼容。

分发本项目编译产物（便携包 / 安装包 / Docker 镜像等）时，请保留各自的版权声明与许可证全文。具体许可证文本可在每个依赖包源码中的 `LICENSE` 文件查阅。

## Backend (Python)

| Package           | License        | Source                                                              |
| ----------------- | -------------- | ------------------------------------------------------------------- |
| fastapi           | MIT            | https://github.com/fastapi/fastapi                                  |
| uvicorn           | BSD-3-Clause   | https://github.com/encode/uvicorn                                   |
| python-multipart  | Apache-2.0     | https://github.com/Kludex/python-multipart                          |
| demoparser2       | MIT            | https://github.com/LaihoE/demoparser                                |
| pandas            | BSD-3-Clause   | https://github.com/pandas-dev/pandas                                |
| obs-websocket-py  | MIT            | https://github.com/Elektordi/obs-websocket-py                       |
| litellm           | MIT            | https://github.com/BerriAI/litellm                                  |
| openai            | Apache-2.0     | https://github.com/openai/openai-python                             |
| pydantic          | MIT            | https://github.com/pydantic/pydantic                                |
| aiosqlite         | MIT            | https://github.com/omnilib/aiosqlite                                |
| watchdog          | Apache-2.0     | https://github.com/gorakhargosh/watchdog                            |

## Frontend (Node)

| Package                 | License | Source                                            |
| ----------------------- | ------- | ------------------------------------------------- |
| react                   | MIT     | https://github.com/facebook/react                 |
| react-dom               | MIT     | https://github.com/facebook/react                 |
| axios                   | MIT     | https://github.com/axios/axios                    |
| lucide-react            | ISC     | https://github.com/lucide-icons/lucide            |
| zustand                 | MIT     | https://github.com/pmndrs/zustand                 |
| tailwindcss             | MIT     | https://github.com/tailwindlabs/tailwindcss       |
| @tailwindcss/vite       | MIT     | https://github.com/tailwindlabs/tailwindcss       |
| vite                    | MIT     | https://github.com/vitejs/vite                    |
| @vitejs/plugin-react    | MIT     | https://github.com/vitejs/vite-plugin-react       |

## Trademark Notices

- *Counter-Strike 2*, *CS2*, *Steam*, and *Valve* are trademarks of Valve Corporation. This project is **not affiliated with, endorsed by, or sponsored by Valve Corporation**.
- *5E* (5E对战平台) and *完美世界竞技平台 (Perfect World Arena)* are trademarks of their respective owners. This project is not affiliated with these platforms; it only consumes the standard `.dem` files they export.
- *OBS Studio* is a trademark of the OBS Project. This project communicates with OBS over the public WebSocket protocol and does not redistribute any OBS code or assets.
