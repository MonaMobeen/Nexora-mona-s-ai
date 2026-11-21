# NEXORA AI — Google Cloud Run Deployment Guide

## 1. Prerequisites
- Google Cloud Project with **Billing enabled**
- Enabled APIs:
  ```bash
  gcloud services enable \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    secretmanager.googleapis.com \
    firestore.googleapis.com \
    logging.googleapis.com
  ```

## 2. Store Secrets in Secret Manager
Never hardcode secrets in containers or source control:
```bash
echo -n "YOUR_REAL_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-
```

Grant your Cloud Run runtime service account least-privilege access:
```bash
PROJECT_NUMBER=$(gcloud projects describe "$GOOGLE_CLOUD_PROJECT" --format="value(projectNumber)")
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## 3. Deploy the Full-Stack NEXORA AI Service (Root Dockerfile)
WebSocket voice streaming requires `--session-affinity` and extended `--timeout`:
```bash
gcloud run deploy nexora-ai \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --port 8080 \
  --timeout 3600 \
  --session-affinity \
  --set-env-vars NODE_ENV=production,RATE_LIMIT_MAX_RPM=90 \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest
```

## 4. Deploy Firestore Security Rules
Deploy `firestore.rules` to your provisioned Firestore database (`firebase-applet-config.json`):
```bash
firebase deploy --only firestore:rules
```

## 5. Optional: Deploy the Standalone Python FastAPI + Google ADK Service
```bash
cd cloudrun-python-adk
gcloud run deploy nexora-python-adk \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --port 8080 \
  --timeout 3600 \
  --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest
```

## 6. Health & Observability
- Health check endpoint: `GET /api/health`
- A2A Agent Card discovery: `GET /.well-known/agent.json`
- Structured JSON logs emit directly to Google Cloud Logging (`stdout`/`stderr`).
