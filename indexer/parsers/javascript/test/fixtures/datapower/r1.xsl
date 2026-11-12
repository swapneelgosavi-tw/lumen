<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:dp="http://www.datapower.com/extensions" extension-element-prefixes="dp">
  <xsl:variable name="uri" select="dp:variable('var://service/URI')"/>
  <xsl:variable name="method" select="dp:variable('var://service/protocol-method')"/>
  <xsl:variable name="base" select="'https://pay.example.com'"/>
  <xsl:variable name="backend">
    <xsl:choose>
      <xsl:when test="starts-with($uri, '/cards')">https://cards.example.com/v1</xsl:when>
      <xsl:otherwise>https://default.example.com</xsl:otherwise>
    </xsl:choose>
  </xsl:variable>
  <xsl:template match="/">
    <xsl:choose>
      <xsl:when test="starts-with($uri, '/payments') and $method = 'POST'">
        <dp:set-variable name="'var://service/routing-url'" value="concat($base, '/api', $uri)"/>
      </xsl:when>
      <xsl:when test="contains($uri, '/refund')">
        <dp:url-open target="concat('https://refund.example.com', $uri)" response="xml"/>
      </xsl:when>
      <xsl:otherwise>
        <dp:set-variable name="'var://service/routing-url'" value="$backend"/>
      </xsl:otherwise>
    </xsl:choose>
  </xsl:template>
</xsl:stylesheet>
