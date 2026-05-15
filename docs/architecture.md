# GoDam architecture (overview)

```mermaid
flowchart LR
  subgraph clients [Clients]
    Web[React_Vite_Admin]
    Mobile[Expo_godam_mobile]
  end
  subgraph node [Node_Express]
    API[REST_API]
    Files[Secure_file_delivery]
  end
  subgraph data [Data]
    PG[(PostgreSQL_warehouse)]
    Huawei[(SQLite_Huawei_plugin)]
  end
  subgraph py [Python]
    OCR[OCR_service]
    AI[AI_plugin]
    Streamlit[Huawei_Streamlit]
  end
  Web --> API
  Mobile --> API
  API --> PG
  API --> Huawei
  API --> OCR
  API --> AI
  Web --> Streamlit
```

- **Auth:** JWT in `Authorization: Bearer` (web stores token in `localStorage`; mobile uses `expo-secure-store`). Optional `jti` revocation on logout (`revoked_tokens` table).
- **Files:** No public `/uploads` static route; browser and API clients use `/api/files/uploads/*` with JWT.
- **Warehousing:** Outbound, FIFO, delivery notes, transportation, BOM, audit logs — see route map in [`backend/mountApiRoutes.js`](../backend/mountApiRoutes.js).
