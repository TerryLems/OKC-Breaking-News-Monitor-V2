const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const FEED_URL =
  "https://services2.arcgis.com/CyVvlIiUfRBmMQuu/arcgis/rest/services/Police_Calls_for_Service_/FeatureServer/0/query";
app.get("/api/incidents", async (req, res) => {
  try {
    const params = new URLSearchParams({
      where: "1=1",
      outFields: "ObjectID,InfoTitle,Call_Type,Address,Reported_Time",
      returnGeometry: "false",
      orderByFields: "Reported_Time DESC",
      resultRecordCount: "100",
      f: "json"
    });

    const response = await fetch(`${FEED_URL}?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Feed returned ${response.status}`);
    }

    const data = await response.json();

    const incidents = (data.features || []).map((feature) => ({
      ...feature.attributes
    }));

    res.json({
      success: true,
      count: incidents.length,
      incidents
    });
  } catch (error) {
    console.error("Feed error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to retrieve OKC incident feed."
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "OKC Breaking News Monitor V2"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OKC Breaking News Monitor running on port ${PORT}`);
});
